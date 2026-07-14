// lib/ollama-guardia.js — "El Guardia": Capa 3/4 de QA de letra, segunda
// opinión INDEPENDIENTE vía LLM local (Ollama).
//
// Motivación: hardValidate (estructura + diccionario) y runGrammarGate
// (LanguageTool) no pueden juzgar coherencia/rima/tono/fidelidad — hoy ese
// juicio subjetivo lo hace SOLO el propio modelo generador vía su
// qaChecklist autoevaluado (run.js), que no es una segunda opinión. Este
// módulo le pasa la letra ya aprobada a un modelo local (default qwen3:14b,
// ver GUARDIA_MODEL abajo) con la encuesta como contexto y pide un veredicto
// estructurado sobre CÓMO ESTÁ ARMADA la canción (pedido explícito de
// Hector 2026-07-11: "más que todo la parte de armar las canciones").
//
// PURAMENTE INFORMATIVO: nunca bloquea, nunca gasta reintentos, nunca lanza
// — mismo criterio que CLAP/NISQA/loudness/pacing ("informativo hasta
// calibrar en vivo", LESSONS.md). run.js loguea el veredicto y lo anota en
// state.json + logs/guardia-feedback.jsonl para comparar contra el QA
// humano real antes de decidir si algún día sube a gate.
//
// Modelo: process.env.GUARDIA_MODEL || 'qwen3:14b'. Hector confirmó 8GB de
// VRAM y que la latencia no es restricción (hasta ~30 min por canción es
// aceptable): qwen3:14b (q4, 9.3GB) no entra entero en 8GB pero Ollama
// descarga las capas sobrantes a CPU/RAM solo (offload parcial) — mejor
// juicio que el 8b a costa de velocidad (~1-3 min por veredicto). Si en
// vivo resulta demasiado lento: `setx GUARDIA_MODEL qwen3:8b` (5.2GB, entra
// entero, responde en segundos) sin tocar código — mismo patrón que
// LANGUAGETOOL_URL en lib/languagetool-check.js. El qwen3.5:9b propuesto
// originalmente NO existe en la librería de Ollama (verificado 2026-07-11).

const LYRICS_SECTION_KEYS = ['Verse 1', 'Chorus 1', 'Verse 2', 'Chorus 2', 'Bridge', 'Outro'];

const DEFAULT_MODEL = 'qwen3:14b';
const DEFAULT_API_URL = 'http://localhost:11434/api/chat';
// La carga fría del 14b con offload parcial puede tomar varios minutos —
// timeout generoso a propósito (Hector aceptó explícitamente la latencia).
const DEFAULT_TIMEOUT_MS = 300000;

// JSON Schema para el campo `format` de la API de Ollama (soportado desde
// 0.5): fuerza la salida estructurada A NIVEL DE API, no por instrucción de
// prompt — mismo principio que output_config.format en lib/llm-provider.js.
const PROBLEMA_TIPOS = ['coherencia', 'rima', 'tono', 'fidelidad', 'gancho', 'estilo', 'estructura', 'otro'];
const PROBLEMA_GRAVEDADES = ['baja', 'media', 'alta'];

// `problemas` estructurado (2026-07-13, en vez de strings libres): para
// poder cruzar automáticamente los hallazgos del Guardia contra los fallos
// de hardValidate y contra el QA humano más adelante hace falta poder
// filtrar/agrupar por sección, tipo y gravedad — un string libre como
// "[Verse 2] línea 3: rima pobre" obliga a re-parsear texto para eso.
// `linea` usa 0 como centinela de "no aplica a una línea específica" (no
// null: los schemas de `format` de Ollama ya vienen usando tipos simples en
// todo este archivo, mejor no introducir el primer nullable acá).
const PROBLEMA_SCHEMA = {
  type: 'object',
  properties: {
    seccion: { type: 'string' }, // "Verse 2", "" si el problema es de la canción entera (ej. tono general)
    linea: { type: 'integer', minimum: 0 }, // 1-indexed; 0 = no aplica a una línea puntual
    tipo: { type: 'string', enum: PROBLEMA_TIPOS },
    gravedad: { type: 'string', enum: PROBLEMA_GRAVEDADES },
    detalle: { type: 'string' },
  },
  required: ['tipo', 'gravedad', 'detalle'],
};

const GUARDIA_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    razonamiento: { type: 'string' },
    coherencia: { type: 'integer', minimum: 1, maximum: 10 },
    rima: { type: 'integer', minimum: 1, maximum: 10 },
    tono: { type: 'integer', minimum: 1, maximum: 10 },
    fidelidad: { type: 'integer', minimum: 1, maximum: 10 },
    gancho: { type: 'integer', minimum: 1, maximum: 10 },
    // Confianza del propio Guardia en su veredicto (1-10) — para calibrar
    // contra el QA humano: un rechazo con confianza 3 pesa distinto que uno
    // con confianza 9 (2026-07-13).
    confianza: { type: 'integer', minimum: 1, maximum: 10 },
    // ¿El estiloSuno pedido (género/instrumentación/voz) es coherente con la
    // ocasión y el tono de la encuesta? Hoy solo se valida que incluya
    // "seseo" (hardValidate J) — nadie juzga si el estilo EN SÍ tiene
    // sentido para la historia (2026-07-13).
    estiloCoincide: { type: 'boolean' },
    problemas: { type: 'array', items: PROBLEMA_SCHEMA },
    veredicto: { type: 'string' },
    aprobada: { type: 'boolean' },
  },
  required: ['razonamiento', 'coherencia', 'rima', 'tono', 'fidelidad', 'gancho', 'confianza', 'estiloCoincide', 'problemas', 'veredicto', 'aprobada'],
};

// Formatea un problema estructurado para consola/notify — un solo lugar
// para no repetir el mismo armado de string en run.js.
function formatGuardiaProblem(p) {
  const ubicacion = p.seccion ? `[${p.seccion}${p.linea > 0 ? ` línea ${p.linea}` : ''}] ` : '';
  return `${ubicacion}(${p.tipo}/${p.gravedad}) ${p.detalle}`;
}

// Arma el prompt de evaluación. Pura — testeable sin red. Incluye la
// encuesta (la historia REAL que la letra debe honrar) para que `fidelidad`
// sea una segunda opinión independiente sobre "nada_inventado", que hoy
// solo se autoevalúa el modelo generador.
//
// qaContext (opcional, 2026-07-13): resultado del QA automático previo
// (hardValidate + LanguageTool) para la pasada INFORMADA del Guardia. La
// pasada 1 va siempre CIEGA (sin esto) para preservar la independencia del
// juicio; la pasada 2 recibe los fallos conocidos y debe confirmarlos o
// descartarlos explícitamente — eso convierte las 2 pasadas (antes
// idénticas, que solo medían ruido de sampleo del mismo modelo) en dos
// perspectivas distintas, y de paso genera el dato de calibración "¿el
// Guardia ve lo mismo que el validador duro?".
function buildGuardiaPrompt({ letras, titulo, survey, qaContext, estiloSuno }) {
  const seccionesTexto = LYRICS_SECTION_KEYS
    .map((key) => `[${key}]\n${(letras[key] || []).join('\n')}`)
    .join('\n\n');

  const qaContextBlock = qaContext && Array.isArray(qaContext.failures) && qaContext.failures.length > 0
    ? [
        '',
        '=== QA AUTOMÁTICO PREVIO (contexto — NO lo repitas ciegamente) ===',
        qaContext.passedQA === false
          ? 'Esta letra NO pasó la validación automática (se agotaron los reintentos de generación). Fallos que el validador detectó:'
          : 'La validación automática detectó estos puntos:',
        ...qaContext.failures.map((f) => `- ${f}`),
        'Verificá cada uno con tu propio criterio: en "problemas", confirmá los que siguen presentes y de verdad importan, y omití los que ya no aplican o son falsos positivos. Tu veredicto es TUYO — no apruebes ni rechaces solo porque el validador dijo algo.',
      ]
    : [];

  return [
    'Sos un evaluador experto de letras de canciones personalizadas en español (estilo cristiano/emotivo, para un cliente real).',
    'Tu ÚNICO trabajo es juzgar cómo está armada esta canción. No reescribas nada, no sugieras versiones alternativas.',
    '',
    '=== ENCUESTA DEL CLIENTE (la historia real que la letra debe honrar) ===',
    survey || '(sin encuesta disponible)',
    '',
    `=== CANCIÓN A EVALUAR: "${titulo || '(sin título)'}" ===`,
    seccionesTexto,
    '',
    `=== ESTILO PEDIDO A SUNO ===`,
    estiloSuno || '(sin estilo especificado)',
    ...qaContextBlock,
    '',
    '=== QUÉ EVALUAR (cada puntaje de 1 a 10) ===',
    '- razonamiento: antes de puntuar fidelidad, hacé un chequeo HECHO POR HECHO, no una impresión general. Primero listá en tu razonamiento TODA afirmación concreta que la canción hace: lugares nombrados (ciudades, países), fechas o hitos, y la secuencia temporal de eventos (qué pasó antes de qué, si dos momentos están presentados como el mismo evento o como continuos). Después, para cada afirmación de esa lista, verificá si aparece literalmente o es directamente inferible de la ENCUESTA de arriba — no de lo que "suena plausible" o poético. Prestá atención especial a: (a) cualquier lugar específico que la letra mencione pero la encuesta no, y (b) la letra fusionando o comprimiendo capítulos de vida separados de la encuesta (ej. dos relaciones, dos épocas, un quiebre y una reconciliación años después) en una sola historia continua sin interrupción — eso es tan inventado como agregar un objeto o lugar falso, aunque ningún dato puntual sea 100% nuevo.',
    '- coherencia: ¿cada línea tiene sentido en español y las secciones cuentan una historia que avanza (Verse 1 → Outro)?',
    '- rima: ¿la rima es rica y consistente, o pobre/forzada/inexistente?',
    '- tono: ¿el tono emocional coincide con la ocasión de la encuesta?',
    '- fidelidad: puntuá BAJO (1-4) si tu chequeo hecho-por-hecho del razonamiento encontró UNA SOLA afirmación concreta (lugar, fecha atada a un evento, o fusión de capítulos separados en uno continuo) que no esté respaldada por la encuesta — incluso si el resto de la letra es fiel y emotiva. No promedies: un solo hecho inventado sobre una historia real personal (matrimonios previos, separaciones, dónde se conocieron) es un fallo grave de fidelidad, no un detalle menor.',
    '- gancho: ¿el coro tiene una línea memorable y cantable?',
    '- confianza: 1-10, qué tan seguro estás de tu propio veredicto (usá valores bajos si dudás).',
    '- estiloCoincide: true si el ESTILO PEDIDO A SUNO (género, instrumentación, energía) tiene sentido para la ocasión y el tono de la encuesta (ej. una balada suave para un funeral tiene sentido, un estilo "upbeat, reggaetón" para un pésame NO). false si hay un desajuste real.',
    '- problemas: lista de problemas CONCRETOS, cada uno un objeto con: seccion (ej. "Verse 2", o "" si es de toda la canción), linea (número de línea dentro de esa sección, 1-indexed; 0 si no aplica a una línea puntual), tipo (uno de: coherencia/rima/tono/fidelidad/gancho/estilo/estructura/otro), gravedad (baja/media/alta), detalle (la descripción concreta del problema, en español). Si el desajuste es de estiloCoincide, reportalo acá con tipo "estilo". Lista vacía si no hay problemas.',
    '- veredicto: una sola frase resumen en español.',
    '- aprobada: true solo si mandarías esta letra a producción sin tocarla. Si fidelidad quedó en 1-4 por un hecho inventado (lugar, fecha, o capítulos de vida fusionados), aprobada DEBE ser false, sin excepción — un fallo de fidelidad nunca se compensa con buena rima, tono o gancho.',
  ].join('\n');
}

// Valida/normaliza el JSON crudo que devuelve el modelo contra la forma
// esperada. Pura — testeable sin red. Devuelve { ok: true, ...campos } o
// { ok: false, error } — nunca lanza, aunque `raw` sea basura.
function parseGuardiaResponse(raw) {
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return { ok: false, error: `respuesta del Guardia no es JSON válido: ${e.message}` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'respuesta del Guardia no es un objeto JSON' };
  }

  const scores = {};
  for (const key of ['coherencia', 'rima', 'tono', 'fidelidad', 'gancho']) {
    const v = Number(data[key]);
    if (!Number.isFinite(v)) {
      return { ok: false, error: `respuesta del Guardia sin puntaje numérico "${key}"` };
    }
    // Clamp defensivo a 1-10: el schema de `format` lo exige, pero un modelo
    // local puede desviarse igual — mejor un valor acotado que propagar 0/99.
    scores[key] = Math.min(10, Math.max(1, Math.round(v)));
  }

  // confianza/estiloCoincide son opcionales al parsear (respuestas viejas/
  // modelos que se desvíen del schema no deben invalidar el veredicto
  // entero) — null si faltan.
  const confianzaRaw = Number(data.confianza);
  const confianza = Number.isFinite(confianzaRaw) ? Math.min(10, Math.max(1, Math.round(confianzaRaw))) : null;
  const estiloCoincide = data.estiloCoincide != null ? String(data.estiloCoincide).toLowerCase() === 'true' : null;

  // problemas estructurado (2026-07-13) — normaliza cada item defensivamente
  // y tolera el formato legado (string libre) por si un modelo se desvía del
  // schema: se envuelve como { tipo: 'otro', gravedad: 'media', detalle }.
  const rawProblemas = Array.isArray(data.problemas) ? data.problemas : (typeof data.problemas === 'object' && data.problemas !== null ? [data.problemas] : []);
  const problemas = rawProblemas
    .map((p) => {
        if (typeof p === 'string' && p.trim()) {
          return { seccion: '', linea: 0, tipo: 'otro', gravedad: 'media', detalle: p.trim() };
        }
        if (!p || typeof p !== 'object' || typeof p.detalle !== 'string' || !p.detalle.trim()) return null;
        const linea = Number(p.linea);
        return {
          seccion: typeof p.seccion === 'string' ? p.seccion : '',
          linea: Number.isFinite(linea) && linea > 0 ? Math.round(linea) : 0,
          tipo: PROBLEMA_TIPOS.includes(p.tipo) ? p.tipo : 'otro',
          gravedad: PROBLEMA_GRAVEDADES.includes(p.gravedad) ? p.gravedad : 'media',
          detalle: p.detalle.trim(),
        };
      }).filter(Boolean);

  return {
    ok: true,
    ...scores,
    confianza,
    estiloCoincide,
    problemas,
    veredicto: typeof data.veredicto === 'string' && data.veredicto.trim() ? data.veredicto.trim() : '(sin veredicto)',
    aprobada: String(data.aprobada).toLowerCase() === 'true',
  };
}

// Llama al Guardia. NUNCA lanza: { ok: false, error } ante cualquier fallo
// (Ollama no instalado/no corriendo, timeout, non-2xx, JSON inválido) — el
// caller (run.js) sigue de largo sin señal esta vez, igual que el gate de
// LanguageTool cuando el servicio no responde.
//
// keepAlive (default 0): 0 descarga el modelo de VRAM apenas responde, para
// no pisarle los 8GB al pipeline de audio (Whisper/Demucs/CLAP/NISQA). PERO
// entre pasadas CONSECUTIVAS del mismo run eso obligaba a pagar la carga
// fría completa (minutos con offload parcial del 14b) en CADA pasada —
// run.js ahora pasa '5m' en todas menos la última de la tanda (2026-07-13);
// el pipeline de audio corre muchos minutos después de este punto, así que
// los 5 min expiran solos mucho antes de que la VRAM haga falta.
async function validarGuardia(
  { letras, titulo, survey, qaContext, estiloSuno },
  {
    model = process.env.GUARDIA_MODEL || DEFAULT_MODEL,
    apiUrl = process.env.GUARDIA_URL || DEFAULT_API_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
    keepAlive = 0,
  } = {}
) {
  if (!letras || typeof letras !== 'object') {
    return { ok: false, error: 'sin letras para evaluar' };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: buildGuardiaPrompt({ letras, titulo, survey, qaContext, estiloSuno }) }],
        stream: false,
        format: GUARDIA_RESPONSE_SCHEMA,
        keep_alive: keepAlive,
        // qwen3 es híbrido con razonamiento: sin esto el output puede venir
        // precedido de tokens de "pensamiento" que inflan latencia y pueden
        // romper el parseo (verificar efecto en vivo en la versión de
        // Ollama instalada — anotar en LESSONS.md si difiere).
        think: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, error: `Ollama respondió ${response.status}: ${(await response.text()).slice(0, 300)}` };
    }

    const data = await response.json();
    const content = data?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return { ok: false, error: 'Ollama respondió sin message.content' };
    }

    const parsed = parseGuardiaResponse(content);
    // `raw` viaja al jsonl de calibración incluso si el parseo falló — sin
    // esto, una respuesta con problemas mal tipados se filtra en silencio y
    // no queda evidencia para auditar (2026-07-13).
    if (!parsed.ok) return { ...parsed, raw: content };

    return { ...parsed, model, durationMs: Date.now() - startedAt, raw: content };
  } catch (e) {
    const error = e.name === 'AbortError'
      ? `timeout de ${timeoutMs}ms esperando al Guardia (¿modelo cargando por primera vez? ¿probar GUARDIA_MODEL=qwen3:8b?)`
      : e.message;
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}

// ── Guardia de AUDIO: segunda opinión semántica sobre falsos positivos de
// Levenshtein/NISQA en voz cantada (2026-07-13) ────────────────────────────
//
// Motivación: verify-audio.js marca "ALUCINACIÓN GRAVE" cuando la similitud
// Levenshtein transcripción-vs-letra cae bajo 75%, y "baja calidad" cuando
// NISQA (entrenado para voz HABLADA, no cantada) cae bajo 50. Caso real
// ("Un Ángel en Jenner", 2026-07-13): Levenshtein 59%/67% y NISQA 23-24/100
// en AMBAS versiones — pero Hector escuchó el MP3 real y no tenía ningún
// problema. Levenshtein carácter-por-carácter no tolera adlibs/alargues de
// vocales/estilo libre de canto, y NISQA nunca se calibró contra voz
// cantada (ver LESSONS.md 2026-07-12). Resultado: falsos positivos que
// mandan a revisión manual canciones que están perfectamente bien.
//
// El Guardia no puede "escuchar" el audio, pero SÍ puede leer la
// transcripción de Whisper (que ya existe, cero costo extra) y juzgar
// SEMÁNTICAMENTE si coincide con la letra pedida — mismo criterio que un
// humano usaría, tolerante a que el reconocimiento de voz cantada nunca es
// perfecto. Corre SIEMPRE (2026-07-13, antes solo con alarma numérica — ver
// verify-audio.js: un Levenshtein/NISQA sanos son compatibles con el nombre
// mal cantado, y gateado por alarma nunca junta verdaderos negativos para
// calibrar).
//
// PURAMENTE INFORMATIVO como el resto de esta Capa 3, mismo criterio de
// "nunca bloquea, nunca lanza, no calibrado en vivo todavía" — ver
// LESSONS.md para la discusión de si algún día pasa a gate real.
const AUDIO_GUARDIA_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    razonamiento: { type: 'string' },
    coincideConLetra: { type: 'boolean' },
    similitud: { type: 'integer', minimum: 1, maximum: 10 },
    // El bit más caro del negocio: ¿la transcripción contiene el/los
    // nombre(s) del destinatario (o una variante fonética razonable de
    // canto)? Un Levenshtein global alto ES compatible con el nombre mal
    // cantado — esta es la señal semántica específica (2026-07-13).
    nombreCorrecto: { type: 'boolean' },
    problemas: { type: 'array', items: { type: 'string' } },
    veredicto: { type: 'string' },
    aprobada: { type: 'boolean' },
    // Triage de fusión de señales (2026-07-13): el Guardia recibe TODAS las
    // señales numéricas informativas del pipeline (no solo Levenshtein/NISQA)
    // + su propio juicio semántico, y devuelve en 1 frase QUÉ conviene
    // revisar primero de oído y POR QUÉ — cruza lo numérico con lo semántico,
    // algo que hoy no existe (cada señal vive aislada en la consola/reporte).
    // Cadena vacía si no hay nada puntual que priorizar.
    prioridadRevision: { type: 'string' },
  },
  required: ['razonamiento', 'coincideConLetra', 'similitud', 'nombreCorrecto', 'problemas', 'veredicto', 'aprobada', 'prioridadRevision'],
};

// Pura — testeable sin red. `nombres` (opcional): lista de nombres de
// destinatario para el chequeo específico de nombreCorrecto.
function buildAudioGuardiaPrompt({ titulo, letraPedida, transcripcion, señales, nombres }) {
  const nombresLine = Array.isArray(nombres) && nombres.length > 0
    ? `- nombreCorrecto: el/los destinatario(s) se llama(n) ${nombres.join(', ')} — true solo si la transcripción contiene ese/esos nombre(s) (o una variante fonética razonable de canto). Este es el error más caro del negocio: un nombre equivocado o irreconocible arruina la canción aunque todo lo demás esté perfecto.`
    : '- nombreCorrecto: true si el nombre del destinatario (según la letra pedida) aparece razonablemente en la transcripción.';
  return [
    'Sos un evaluador de calidad de audio de canciones personalizadas generadas por IA (Suno), para un negocio real de canciones dedicadas a clientes.',
    'Te paso la LETRA QUE SE PIDIÓ y la TRANSCRIPCIÓN AUTOMÁTICA (Whisper) de lo que Suno realmente cantó, más señales numéricas automáticas.',
    'OJO: esas señales numéricas (Levenshtein carácter-por-carácter, NISQA entrenado para voz HABLADA no cantada) dan MUCHOS falsos positivos sobre voz cantada real — adlibs, alargues de vocales, repeticiones de estilo, pronunciación libre. Eso es NORMAL en una canción cantada, NO es un error. No repitas ciegamente esos números en tu juicio: escuchá (leé) la transcripción con criterio humano.',
    '',
    `=== CANCIÓN: "${titulo || '(sin título)'}" ===`,
    '',
    '=== LETRA PEDIDA ===',
    letraPedida || '(sin letra disponible)',
    '',
    '=== TRANSCRIPCIÓN AUTOMÁTICA (Whisper, sobre voz cantada — puede tener errores de reconocimiento normales) ===',
    transcripcion || '(sin transcripción disponible)',
    '',
    '=== SEÑALES AUTOMÁTICAS (de referencia, no decidas solo con esto — pueden incluir Levenshtein, NISQA, CLAP, loudness EBU R128, género de voz detectado (F0), palabras/nombres pegados sin pausa, palabras posiblemente cortadas, calidad musical percibida y de producción) ===',
    señales || '(sin señales)',
    '',
    'Tu trabajo: comparar SEMÁNTICAMENTE la transcripción contra la letra pedida y decidir si esta versión suena a que Suno cantó la canción correcta, o si hay una alucinación REAL (versos inventados de otro tema, nombre del destinatario equivocado, corte grave de contenido, tema completamente distinto al pedido).',
    '- razonamiento: escribí 1-2 párrafos analizando los fallos y aciertos de la canción antes de dar tus puntajes. Esto te ayudará a pensar mejor.',
    '- coincideConLetra: true si el contenido cantado corresponde razonablemente a la letra pedida (tolerando imperfecciones normales de transcripción de canto).',
    '- similitud: 1-10, tu propio juicio de fidelidad real de CONTENIDO (no repitas el número de Levenshtein/NISQA que te pasé).',
    nombresLine,
    '- problemas: lista de problemas REALES y concretos si los hay (vacía si no hay ninguno).',
    '- veredicto: una frase resumen en español.',
    '- aprobada: true si mandarías este audio a un cliente real sin dudarlo.',
    '- prioridadRevision: mirando TODAS las señales automáticas de arriba MÁS tu propio juicio semántico, en una sola frase decime qué es lo más importante para un humano revisar de oído en esta versión y por qué (ej. "revisar el segundo 45: género de voz detectado no coincide con lo esperado Y hay una palabra posiblemente cortada ahí" — o si varias señales numéricas están mal pero tu juicio semántico dice que el contenido es correcto, decilo: "las alarmas numéricas son probable falso positivo de voz cantada, el contenido real está bien"). Cadena vacía si no hay nada puntual que priorizar.',
  ].join('\n');
}

// Pura — testeable sin red.
function parseAudioGuardiaResponse(raw) {
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return { ok: false, error: `respuesta del Guardia de audio no es JSON válido: ${e.message}` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'respuesta del Guardia de audio no es un objeto JSON' };
  }
  const similitud = Number(data.similitud);
  if (!Number.isFinite(similitud)) {
    return { ok: false, error: 'respuesta del Guardia de audio sin puntaje numérico "similitud"' };
  }
  return {
    ok: true,
    coincideConLetra: String(data.coincideConLetra).toLowerCase() === 'true',
    similitud: Math.min(10, Math.max(1, Math.round(similitud))),
    // null si el modelo no lo mandó (respuestas viejas) — false solo si
    // el Guardia lo evaluó y dijo que no.
    nombreCorrecto: data.nombreCorrecto != null ? String(data.nombreCorrecto).toLowerCase() === 'true' : null,
    problemas: Array.isArray(data.problemas) ? data.problemas.filter((p) => typeof p === 'string') : [],
    veredicto: typeof data.veredicto === 'string' && data.veredicto.trim() ? data.veredicto.trim() : '(sin veredicto)',
    aprobada: String(data.aprobada).toLowerCase() === 'true',
    prioridadRevision: typeof data.prioridadRevision === 'string' ? data.prioridadRevision.trim() : '',
  };
}

// Mismo contrato que validarGuardia: NUNCA lanza, { ok: false, error } ante
// cualquier fallo, keep_alive: 0 para no pisarle VRAM al pipeline de audio.
async function evaluarAudioGuardia(
  { titulo, letraPedida, transcripcion, señales, nombres },
  {
    model = process.env.GUARDIA_MODEL || DEFAULT_MODEL,
    apiUrl = process.env.GUARDIA_URL || DEFAULT_API_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
    keepAlive = 0,
  } = {}
) {
  if (!letraPedida) {
    return { ok: false, error: 'sin letra pedida para comparar' };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: buildAudioGuardiaPrompt({ titulo, letraPedida, transcripcion, señales, nombres }) }],
        stream: false,
        format: AUDIO_GUARDIA_RESPONSE_SCHEMA,
        keep_alive: keepAlive,
        think: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, error: `Ollama respondió ${response.status}: ${(await response.text()).slice(0, 300)}` };
    }

    const data = await response.json();
    const content = data?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return { ok: false, error: 'Ollama respondió sin message.content' };
    }

    const parsed = parseAudioGuardiaResponse(content);
    if (!parsed.ok) return { ...parsed, raw: content };

    return { ...parsed, model, durationMs: Date.now() - startedAt, raw: content };
  } catch (e) {
    const error = e.name === 'AbortError'
      ? `timeout de ${timeoutMs}ms esperando al Guardia de audio (¿modelo cargando por primera vez? ¿probar GUARDIA_MODEL=qwen3:8b?)`
      : e.message;
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}

// ── Extracción CERRADA de hechos + comparación EN CÓDIGO (2026-07-14) ───────
//
// Motivación (caso real "El Hombre De Mi Vida", ver LESSONS.md): pedirle al
// Guardia que JUZGUE la fidelidad no funciona — qwen3:14b dio fidelidad=10 a
// una letra con "Miami" inventado incluso con el prompt endurecido pidiendo
// chequeo hecho-por-hecho. Pero EXTRAER es una tarea mucho más fácil que
// juzgar: acá el modelo solo lista qué lugares/personas/fechas AFIRMA la
// letra (sin opinar), y compararHechosConEncuesta decide EN CÓDIGO si cada
// uno está respaldado por la encuesta — el LLM extrae, el código juzga.
// Complementa el chequeo N determinístico de hardValidate (que solo ve
// tokens Capitalizados mid-línea): esto también agarra hechos en minúscula
// ("un martes de octubre" inventado) y da la señal semántica calibrable.
//
// PURAMENTE INFORMATIVO (mismo protocolo que el resto de la Capa 3: consola
// + state.json + guardia-feedback.jsonl hasta calibrar contra QA humano).
// Criterio de graduación a gate: cuando el jsonl acumule suficientes casos
// reales sin falsos positivos, esto puede pasar a disparar el regen
// automático igual que el chequeo N — es el camino al 100% automático.
const EXTRACCION_SCHEMA = {
  type: 'object',
  properties: {
    // Solo lo que la letra AFIRMA — no inferencias ni temas.
    lugares: { type: 'array', items: { type: 'string' } },
    personas: { type: 'array', items: { type: 'string' } },
    fechasOMomentos: { type: 'array', items: { type: 'string' } },
  },
  required: ['lugares', 'personas', 'fechasOMomentos'],
};

function buildExtraccionPrompt({ letras, titulo }) {
  const seccionesTexto = LYRICS_SECTION_KEYS
    .map((key) => `[${key}]\n${(letras[key] || []).join('\n')}`)
    .join('\n\n');
  return [
    'Sos un extractor de datos. NO evalúes, NO opines, NO juzgues la calidad — solo LISTÁ.',
    '',
    `=== LETRA: "${titulo || '(sin título)'}" ===`,
    seccionesTexto,
    '',
    'Listá TODO lo que esta letra afirma de forma concreta:',
    '- lugares: cada lugar geográfico nombrado o inequívocamente referido (ciudades, países, barrios, "la isla" si refiere a un lugar concreto NO — solo nombres propios de lugar como "Miami", "Cuba").',
    '- personas: cada nombre de persona que aparece.',
    '- fechasOMomentos: cada fecha, edad, cantidad o momento TEMPORAL concreto que la letra afirma ("trece de mayo", "diecisiete años", "tres nietos", "un martes de octubre"). NO listes frases poéticas o abstractas sin dato concreto ("un mismo destino", "el tiempo se detuvo") — solo datos verificables.',
    'Listas vacías si no hay. Copiá el texto tal como aparece en la letra.',
  ].join('\n');
}

function parseExtraccionResponse(raw) {
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return { ok: false, error: `respuesta de extracción no es JSON válido: ${e.message}` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'respuesta de extracción no es un objeto JSON' };
  }
  const lista = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
  return {
    ok: true,
    lugares: lista(data.lugares),
    personas: lista(data.personas),
    fechasOMomentos: lista(data.fechasOMomentos),
  };
}

// Mismo contrato de red que validarGuardia: NUNCA lanza.
async function extraerHechosLetra(
  { letras, titulo },
  {
    model = process.env.GUARDIA_MODEL || DEFAULT_MODEL,
    apiUrl = process.env.GUARDIA_URL || DEFAULT_API_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
    keepAlive = 0,
  } = {}
) {
  if (!letras || typeof letras !== 'object') {
    return { ok: false, error: 'sin letras para extraer' };
  }
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: buildExtraccionPrompt({ letras, titulo }) }],
        stream: false,
        format: EXTRACCION_SCHEMA,
        keep_alive: keepAlive,
        think: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `Ollama respondió ${response.status}: ${(await response.text()).slice(0, 300)}` };
    }
    const data = await response.json();
    const content = data?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return { ok: false, error: 'Ollama respondió sin message.content' };
    }
    const parsed = parseExtraccionResponse(content);
    if (!parsed.ok) return { ...parsed, raw: content };
    return { ...parsed, model, durationMs: Date.now() - startedAt, raw: content };
  } catch (e) {
    const error = e.name === 'AbortError'
      ? `timeout de ${timeoutMs}ms esperando la extracción de hechos`
      : e.message;
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}

// Comparación PURA en código — testeable sin red. Un hecho extraído está
// respaldado si sus tokens aparecen en la encuesta (normalizados sin tildes/
// mayúsculas, con dígitos de la encuesta expandidos a palabras: "13 de mayo"
// respalda "trece de mayo"). Regla de flag calibrada con el banco dorado
// (guardia-benchmark.js — el caso "la casa" del 2026-07-14 fue un falso
// positivo real sobre la letra BUENA que obligó a afinarla):
//   - cualquier token CAPITALIZADO del hecho ausente de la encuesta → flag
//     ("Miami"), salvo whitelist religiosa (regla 8) / respellings.
//   - un hecho SIN mayúsculas solo se marca si contiene un dato TEMPORAL o
//     NUMÉRICO sin respaldo ("un martes de octubre" inventado, "veinte años"
//     que la encuesta no dice). Sustantivos comunes sin dato ("la casa",
//     "la isla", "el mar") NUNCA se marcan: son escenografía poética que la
//     regla 2 del SYSTEM_PROMPT permite inferir explícitamente.
const HECHOS_TEMPORAL_TOKENS = new Set([
  // meses y días
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'setiembre', 'octubre', 'noviembre', 'diciembre',
  'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo',
  // números en palabras (los que aparecen en encuestas reales: edades, fechas, cantidades)
  'cero', 'uno', 'una', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez',
  'once', 'doce', 'trece', 'catorce', 'quince', 'dieciseis', 'diecisiete', 'dieciocho', 'diecinueve',
  'veinte', 'veintiuno', 'veintidos', 'veintitres', 'veinticuatro', 'veinticinco', 'veintiseis', 'veintisiete', 'veintiocho', 'veintinueve',
  'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa', 'cien', 'ciento', 'mil',
  'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos',
]);
function compararHechosConEncuesta(hechos, surveyText, { firstNames = [] } = {}) {
  const { numberToSpanishWords, MIDLINE_PROPER_NOUN_WHITELIST, stripAccents } = require('./song-validate');
  const norm = (t) => stripAccents(t).toLowerCase();
  const surveyTokens = new Set();
  for (const tok of String(surveyText || '').match(/[a-záéíóúüñA-ZÁÉÍÓÚÜÑ0-9]+/g) || []) {
    surveyTokens.add(norm(tok));
    if (/^\d+$/.test(tok)) {
      const n = parseInt(tok, 10);
      // Dígitos de la encuesta → palabras ("13" respalda "trece"). Para los
      // terminados en 1 (apócope, numberToSpanishWords devuelve null) se
      // agregan las variantes un/uno/una y los vecinos — solo AGREGA
      // respaldo, nunca lo quita (capa informativa, mejor tolerante).
      for (const cand of [numberToSpanishWords(n), numberToSpanishWords(n - 1), numberToSpanishWords(n + 1), n % 10 === 1 ? 'un uno una veintiun veintiuno' : null]) {
        if (cand) for (const w of cand.split(/\s+/)) surveyTokens.add(norm(w));
      }
    }
  }
  for (const name of firstNames) surveyTokens.add(norm(name));

  const evaluar = (tipo, valor) => {
    const rawTokens = valor.match(/[a-záéíóúüñA-ZÁÉÍÓÚÜÑ0-9]+/g) || [];
    if (rawTokens.length === 0) return null;
    const capitalizados = rawTokens.filter((t) => /^[A-ZÁÉÍÓÚÜÑ]/.test(t) && !MIDLINE_PROPER_NOUN_WHITELIST.has(norm(t)));
    const capSinRespaldo = capitalizados.filter((t) => !surveyTokens.has(norm(t)));
    if (capSinRespaldo.length > 0) return { tipo, valor, motivo: `"${capSinRespaldo.join('", "')}" no aparece en la encuesta` };
    const temporalesSinRespaldo = rawTokens.filter((t) => HECHOS_TEMPORAL_TOKENS.has(norm(t)) && !surveyTokens.has(norm(t)));
    if (temporalesSinRespaldo.length > 0) {
      return { tipo, valor, motivo: `el dato temporal/numérico "${temporalesSinRespaldo.join('", "')}" no aparece en la encuesta` };
    }
    return null;
  };

  const sinRespaldo = [];
  let evaluados = 0;
  for (const [tipo, lista] of [['lugar', hechos.lugares], ['persona', hechos.personas], ['fecha/momento', hechos.fechasOMomentos]]) {
    for (const valor of lista || []) {
      evaluados++;
      const r = evaluar(tipo, valor);
      if (r) sinRespaldo.push(r);
    }
  }
  return { evaluados, sinRespaldo };
}

module.exports = {
  buildGuardiaPrompt,
  parseGuardiaResponse,
  validarGuardia,
  GUARDIA_RESPONSE_SCHEMA,
  formatGuardiaProblem,
  buildAudioGuardiaPrompt,
  parseAudioGuardiaResponse,
  evaluarAudioGuardia,
  AUDIO_GUARDIA_RESPONSE_SCHEMA,
  LYRICS_SECTION_KEYS,
  DEFAULT_MODEL,
  buildExtraccionPrompt,
  parseExtraccionResponse,
  extraerHechosLetra,
  compararHechosConEncuesta,
  EXTRACCION_SCHEMA,
};
