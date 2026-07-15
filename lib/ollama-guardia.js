// lib/ollama-guardia.js — "El Guardia": Capa 3/4 de QA de letra, segunda
// opinión INDEPENDIENTE vía LLM (Claude Haiku, API de Anthropic).
//
// Motivación: hardValidate (estructura + diccionario) y runGrammarGate
// (LanguageTool) no pueden juzgar coherencia/rima/tono/fidelidad — hoy ese
// juicio subjetivo lo hace SOLO el propio modelo generador vía su
// qaChecklist autoevaluado (run.js), que no es una segunda opinión. Este
// módulo le pasa la letra ya aprobada a Claude Haiku con la encuesta como
// contexto y pide un veredicto estructurado sobre CÓMO ESTÁ ARMADA la
// canción (pedido explícito de Hector 2026-07-11: "más que todo la parte
// de armar las canciones").
//
// ⚠️ MIGRACIÓN 2026-07-14: este módulo corría 100% en Ollama LOCAL Y GRATIS
// (qwen3:14b). Se migró a la API de Claude (Haiku) — nombre conservado
// ("ollama-guardia.js") por no romper imports, pero ya NO es local ni
// gratis: cada llamada (2-3 pasadas de letra + extracción de hechos +
// Guardia de audio ×2 versiones + el reprompt de abajo si hay problemas)
// gasta créditos reales de ANTHROPIC_API_KEY, en cada canción, siempre.
// `--dry-run` salta este módulo por completo por eso mismo (ver run.js) —
// antes lo corría igual porque Ollama no costaba nada; ahora sí costaría.
// Requiere `ANTHROPIC_API_KEY` configurada — sin ella, `ok: false` en vez
// de lanzar (mismo contrato "nunca lanza" de siempre).
//
// PURAMENTE INFORMATIVO: nunca bloquea, nunca gasta reintentos, nunca lanza
// — mismo criterio que CLAP/NISQA/loudness/pacing ("informativo hasta
// calibrar en vivo", LESSONS.md). run.js loguea el veredicto y lo anota en
// state.json + logs/guardia-feedback.jsonl para comparar contra el QA
// humano real antes de decidir si algún día sube a gate.
//
// Modelo: process.env.GUARDIA_MODEL || 'claude-haiku-4-5' (ID real de
// Anthropic, sin fecha — ver shared/models.md de la skill claude-api). Si
// alguna vez se override GUARDIA_MODEL a mano, debe ser un model ID de
// Anthropic válido — un nombre de modelo de Ollama (ej. "qwen3:8b") rompe
// TODAS las llamadas al Guardia silenciosamente (nunca lanza, solo deja de
// dar señal — revisar logs/guardia-feedback.jsonl si el Guardia desaparece
// de golpe).

const LYRICS_SECTION_KEYS = ['Verse 1', 'Chorus 1', 'Verse 2', 'Chorus 2', 'Bridge', 'Outro'];

const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_API_URL = 'https://api.anthropic.com/v1/messages';
// Haiku es muy rápido, 60s es generoso
const DEFAULT_TIMEOUT_MS = 60000;

// JSON Schema para output_config.format de la API de Anthropic: fuerza la
// salida estructurada A NIVEL DE API, no por instrucción de prompt — mismo
// principio que output_config.format en lib/llm-provider.js.
const PROBLEMA_TIPOS = ['coherencia', 'rima', 'tono', 'fidelidad', 'gancho', 'estilo', 'estructura', 'otro'];
const PROBLEMA_GRAVEDADES = ['baja', 'media', 'alta'];

// `problemas` estructurado (2026-07-13, en vez de strings libres): para
// poder cruzar automáticamente los hallazgos del Guardia contra los fallos
// de hardValidate y contra el QA humano más adelante hace falta poder
// filtrar/agrupar por sección, tipo y gravedad — un string libre como
// "[Verse 2] línea 3: rima pobre" obliga a re-parsear texto para eso.
// `linea` usa 0 como centinela de "no aplica a una línea específica" (no
// null: los schemas de `format` de Anthropic ya vienen usando tipos simples
// en todo este archivo, mejor no introducir el primer nullable acá).
const PROBLEMA_SCHEMA = {
  type: 'object',
  // additionalProperties:false es EXIGIDO por output_config.format de
  // Anthropic para todo objeto (bug real 2026-07-14: sin esto, 400
  // "additionalProperties must be explicitly set to false" — Ollama nunca
  // lo pedía, así que la migración lo dejó afuera y el Guardia quedó roto
  // desde el día 1, fallando en silencio por el contrato "nunca lanza". Ver
  // LESSONS.md).
  additionalProperties: false,
  properties: {
    seccion: { type: 'string' }, // "Verse 2", "" si el problema es de la canción entera (ej. tono general)
    linea: { type: 'integer' }, // 1-indexed; 0 = no aplica a una línea puntual
    tipo: { type: 'string', enum: PROBLEMA_TIPOS },
    gravedad: { type: 'string', enum: PROBLEMA_GRAVEDADES },
    detalle: { type: 'string' },
  },
  required: ['tipo', 'gravedad', 'detalle'],
};

const GUARDIA_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    razonamiento: { type: 'string' },
    // Sin minimum/maximum a propósito (bug real 2026-07-14: output_config.format
    // de Anthropic rechaza esas keywords en integers — "properties maximum,
    // minimum are not supported" — Ollama las toleraba sin problema. El clamp
    // a 1-10 sigue pasando EN CÓDIGO en parseGuardiaResponse, así que el
    // contrato de puntaje 1-10 no se pierde, solo se deja de exigir a nivel
    // de schema).
    coherencia: { type: 'integer' },
    rima: { type: 'integer' },
    tono: { type: 'integer' },
    fidelidad: { type: 'integer' },
    gancho: { type: 'integer' },
    // Confianza del propio Guardia en su veredicto (1-10) — para calibrar
    // contra el QA humano: un rechazo con confianza 3 pesa distinto que uno
    // con confianza 9 (2026-07-13).
    confianza: { type: 'integer' },
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
    '- fidelidad: puntuá BAJO (1-4) si tu chequeo hecho-por-hecho del razonamiento encontró UNA SOLA afirmación concreta (lugar, fecha atada a un evento, o fusión de capítulos separados en uno continuo) que no esté respaldada por la encuesta — incluso si el resto de la letra es fiel y emotiva. No promedies: un solo hecho inventado sobre una historia real personal (matrimonios previos, separaciones, dónde se conocieron) es un fallo grave de fidelidad, no un detalle menor. IMPORTANTE — distinguí dos problemas DISTINTOS que no son igual de graves: (a) FUSIÓN/INVENCIÓN real (la letra afirma algo que la encuesta no dice, o presenta dos capítulos distintos como si fueran uno) = fidelidad 1-4, siempre; (b) AMBIGÜEDAD DE REDACCIÓN (la letra menciona correctamente dos eventos similares —dos viajes, dos casas— pero una línea puntual usa un pronombre genérico como "aquel camino"/"ese día" en vez de nombrar a cuál de los dos se refiere, aunque el hecho SÍ esté en la encuesta) = esto es un problema de CLARIDAD en una línea específica, NO una invención — puntuá fidelidad 5-6 (no 1-4) y reportalo con tipo "coherencia", nunca "fidelidad", para que quede claro que la letra no inventó nada, solo necesita nombrar el evento en esa línea.',
    '- gancho: ¿el coro tiene una línea memorable y cantable?',
    '- confianza: 1-10, qué tan seguro estás de tu propio veredicto (usá valores bajos si dudás).',
    '- estiloCoincide: true si el ESTILO PEDIDO A SUNO (género, instrumentación, energía) tiene sentido para la ocasión y el tono de la encuesta (ej. una balada suave para un funeral tiene sentido, un estilo "upbeat, reggaetón" para un pésame NO). false si hay un desajuste real.',
    '- problemas: lista de problemas CONCRETOS, cada uno un objeto con: seccion, linea (número de línea dentro de esa sección, 1-indexed), tipo (uno de: coherencia/rima/tono/fidelidad/gancho/estilo/estructura/otro), gravedad (baja/media/alta), detalle (la descripción concreta del problema, en español). ANCLÁ CADA PROBLEMA A UNA LÍNEA SIEMPRE QUE SE PUEDA — incluso un problema que "afecta a toda la canción" casi siempre tiene UNA línea donde se nota más (ej. la ambigüedad de "aquel camino" vive en una línea concreta del Verso 2, aunque la razón involucre otra línea también): identificá esa línea y usá seccion+linea reales. Reservá seccion="" y linea=0 SOLO para algo que de verdad no tiene ninguna línea específica (ej. "el arco general de la canción es plano"). Si el desajuste es de estiloCoincide, reportalo acá con tipo "estilo". Lista vacía si no hay problemas.',
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
// (ANTHROPIC_API_KEY faltante, timeout, non-2xx, JSON inválido) — el caller
// (run.js) sigue de largo sin señal esta vez, igual que el gate de
// LanguageTool cuando el servicio no responde.
async function validarGuardia(
  { letras, titulo, survey, qaContext, estiloSuno },
  {
    model = process.env.GUARDIA_MODEL || DEFAULT_MODEL,
    apiUrl = process.env.GUARDIA_URL || DEFAULT_API_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
  } = {}
) {
  if (!letras || typeof letras !== 'object') {
    return { ok: false, error: 'sin letras para evaluar' };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, error: 'ANTHROPIC_API_KEY no está configurada.' };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        thinking: { type: 'disabled' },
        output_config: { format: { type: 'json_schema', schema: GUARDIA_RESPONSE_SCHEMA } },
        messages: [{ role: 'user', content: buildGuardiaPrompt({ letras, titulo, survey, qaContext, estiloSuno }) }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, error: `Anthropic respondió ${response.status}: ${(await response.text()).slice(0, 300)}` };
    }

    const data = await response.json();
    const content = data?.content?.map((block) => block.text || '').join('').trim();
    if (!content) {
      return { ok: false, error: 'Anthropic respondió sin texto' };
    }

    const parsed = parseGuardiaResponse(content);
    // `raw` viaja al jsonl de calibración incluso si el parseo falló — sin
    // esto, una respuesta con problemas mal tipados se filtra en silencio y
    // no queda evidencia para auditar (2026-07-13).
    if (!parsed.ok) return { ...parsed, raw: content };

    return { ...parsed, model, durationMs: Date.now() - startedAt, raw: content };
  } catch (e) {
    const error = e.name === 'AbortError'
      ? `timeout de ${timeoutMs}ms esperando al Guardia (¿ANTHROPIC_API_KEY válida? ¿rate limit? revisá logs/guardia-feedback.jsonl)`
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
  additionalProperties: false,
  properties: {
    razonamiento: { type: 'string' },
    coincideConLetra: { type: 'boolean' },
    similitud: { type: 'integer' },
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
// cualquier fallo.
async function evaluarAudioGuardia(
  { titulo, letraPedida, transcripcion, señales, nombres },
  {
    model = process.env.GUARDIA_MODEL || DEFAULT_MODEL,
    apiUrl = process.env.GUARDIA_URL || DEFAULT_API_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
  } = {}
) {
  if (!letraPedida) {
    return { ok: false, error: 'sin letra pedida para comparar' };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, error: 'ANTHROPIC_API_KEY no está configurada.' };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        thinking: { type: 'disabled' },
        output_config: { format: { type: 'json_schema', schema: AUDIO_GUARDIA_RESPONSE_SCHEMA } },
        messages: [{ role: 'user', content: buildAudioGuardiaPrompt({ titulo, letraPedida, transcripcion, señales, nombres }) }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, error: `Anthropic respondió ${response.status}: ${(await response.text()).slice(0, 300)}` };
    }

    const data = await response.json();
    const content = data?.content?.map((block) => block.text || '').join('').trim();
    if (!content) {
      return { ok: false, error: 'Anthropic respondió sin texto' };
    }

    const parsed = parseAudioGuardiaResponse(content);
    if (!parsed.ok) return { ...parsed, raw: content };

    return { ...parsed, model, durationMs: Date.now() - startedAt, raw: content };
  } catch (e) {
    const error = e.name === 'AbortError'
      ? `timeout de ${timeoutMs}ms esperando al Guardia de audio (¿ANTHROPIC_API_KEY válida? ¿rate limit?)`
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
  additionalProperties: false,
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
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, error: 'ANTHROPIC_API_KEY no está configurada.' };
  }
  
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        thinking: { type: 'disabled' },
        output_config: { format: { type: 'json_schema', schema: EXTRACCION_SCHEMA } },
        messages: [{ role: 'user', content: buildExtraccionPrompt({ letras, titulo }) }],
      }),
      signal: controller.signal,
    });
    
    if (!response.ok) {
      return { ok: false, error: `Anthropic respondió ${response.status}: ${(await response.text()).slice(0, 300)}` };
    }
    
    const data = await response.json();
    const content = data?.content?.map((block) => block.text || '').join('').trim();
    if (!content) {
      return { ok: false, error: 'Anthropic respondió sin texto' };
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

// ─── FACT_GATE: graduación de la extracción de hechos a gate (2026-07-14) ────
// Decisión PURA (test/ollama-guardia.test.js) sobre qué hacer cuando la
// comparación de hechos encuentra afirmaciones sin respaldo en la encuesta.
// Modos (env FACT_GATE, default 'warn' = comportamiento histórico):
//   off   → la señal ni se reporta como problema.
//   warn  → solo consola/jsonl (informativo — el modo de calibración).
//   regen → dispara el MISMO regen que el chequeo N, dentro del presupuesto
//           de MAX_GENERATION_ATTEMPTS. Kill-switch: volver a warn/off.
// Degradación automática: si el fact-gate ya provocó 2 regens en la MISMA
// canción, baja a warn para esa canción — un gate mal calibrado a las 3 AM
// no debe quemar el presupuesto entero de intentos ni frenar la cola.
// Criterio para activar 'regen' (ver guardia-benchmark.js --readiness):
// banco dorado en verde (0 FP en letras buenas) + ≥15 canciones reales
// consecutivas sin falso positivo en guardia-feedback.jsonl.
function decideFactGateAction({ sinRespaldoCount = 0, mode = process.env.FACT_GATE, regenCount = 0 } = {}) {
  const m = String(mode || 'warn').toLowerCase();
  const effective = ['off', 'warn', 'regen'].includes(m) ? m : 'warn';
  if (effective === 'off') return 'off';
  if (sinRespaldoCount === 0) return 'pass';
  if (effective === 'warn') return 'warn';
  if (regenCount >= 2) return 'degrade-warn';
  return 'regen';
}

// ─── Recuperación automática de rechazos por AMBIGÜEDAD (2026-07-15) ────────
// Incidente real que motivó esto ("El Pañuelo Azul y Blanco"): el Guardia
// rechazó por "fidelidad" una letra donde la extracción determinística de
// hechos (compararHechosConEncuesta, más confiable — ver LESSONS.md caso
// "Miami") NO encontró NADA sin respaldo. El problema real no era invención,
// era una línea con un pronombre genérico ("aquel camino") que no aclaraba
// a cuál de dos eventos similares de la encuesta se refería — algo que
// Sonnet puede arreglar solo si se le señala, en vez de trabar la canción en
// una pausa humana con 20 min de reloj.
//
// shouldAttemptAmbiguityRecovery decide si vale la pena darle a Sonnet UN
// intento automático de arreglarlo ANTES de pausar. Condiciones, TODAS:
//   1. Nunca se intentó ya en esta canción (alreadyAttempted) — un solo
//      intento extra, nunca un loop sin fondo.
//   2. La extracción de hechos corrió y encontró CERO afirmaciones sin
//      respaldo — la señal más confiable dice "no hay nada inventado".
//   3. CADA pasada que rechazó tiene el perfil de "ambigüedad, no invención
//      real": marcó un problema de fidelidad/coherencia con gravedad
//      media/alta, PERO el resto de sus puntajes (coherencia, rima, tono)
//      son razonables — una letra genuinamente mala en varios frentes NO
//      califica (esa sí necesita un humano).
// Pura y testeada (test/ollama-guardia.test.js) — nunca toca red ni disco.
function shouldAttemptAmbiguityRecovery({ rejectingVeredictos, hechosSinRespaldo, alreadyAttempted = false } = {}) {
  if (alreadyAttempted) return false;
  if (!hechosSinRespaldo || !Array.isArray(hechosSinRespaldo.sinRespaldo) || hechosSinRespaldo.sinRespaldo.length > 0) return false;
  if (!Array.isArray(rejectingVeredictos) || rejectingVeredictos.length === 0) return false;
  return rejectingVeredictos.every((v) => {
    if (!v || v.aprobada !== false) return false;
    const problemas = Array.isArray(v.problemas) ? v.problemas : [];
    const tieneProblemaDeAmbiguedad = problemas.some(
      (p) => (p.tipo === 'fidelidad' || p.tipo === 'coherencia') && (p.gravedad === 'alta' || p.gravedad === 'media')
    );
    if (!tieneProblemaDeAmbiguedad) return false;
    const num = (x, fallback) => (Number.isFinite(x) ? x : fallback);
    return num(v.fidelidad, 0) <= 6 && num(v.coherencia, 0) >= 7 && num(v.rima, 10) >= 6 && num(v.tono, 0) >= 7;
  });
}

// Arma el mensaje correctivo para el siguiente intento de generación,
// citando textualmente los problemas de las pasadas que rechazaron — mismo
// patrón que las correctiveNotes de hardValidate en generateSongWithSelfCorrection
// (run.js), aplicado acá a la crítica del Guardia. Pura, testeada.
function buildAmbiguityCorrectiveNote(rejectingVeredictos) {
  const detalles = [];
  for (const v of rejectingVeredictos || []) {
    for (const p of v?.problemas || []) {
      if ((p.tipo === 'fidelidad' || p.tipo === 'coherencia') && p.detalle) {
        const ubicacion = p.seccion ? `[${p.seccion}${p.linea > 0 ? ` línea ${p.linea}` : ''}] ` : '';
        detalles.push(`${ubicacion}${p.detalle}`);
      }
    }
  }
  const unicos = [...new Set(detalles)];
  return [
    'CORRECCIÓN OBLIGATORIA — un revisor independiente marcó ambigüedad (NO invención: no agregues hechos nuevos, ya están todos en la encuesta) en:',
    ...unicos.map((d) => `- ${d}`),
    'Reescribí ÚNICAMENTE las líneas señaladas para que quede explícito a cuál evento/lugar/fecha de la encuesta se refiere cada una — nombrá el lugar o la fecha en esa misma línea en vez de un pronombre genérico ("aquel camino", "ese día"). No cambies nada más de la canción.',
  ].join('\n');
}

// ─── Recuperación GENERAL de rechazos del Guardia (2026-07-15, mismo día) ────
// shouldAttemptAmbiguityRecovery arriba nació estrecho a propósito (solo el
// perfil "ambigüedad pura") mientras la prioridad era "no debilitar el
// gate". Pedido explícito de Hector el mismo día: el propósito de tener DOS
// modelos (Sonnet genera, Haiku audita) es que se corrijan ENTRE ELLOS sin
// que él tenga que intervenir — la pausa humana debe ser el último recurso,
// no el primero. Esto generaliza: CUALQUIER rechazo del Guardia (no solo
// ambigüedad) dispara hasta MAX_GUARDIA_RECOVERY_ATTEMPTS regens
// automáticos citando los problemas exactos que reportó, antes de pausar.
// Sigue acotado (nunca un loop infinito) y sigue sin tocar NADA relacionado
// con Suno/créditos — ese dominio no cambia. Pura y testeada.
const MAX_GUARDIA_RECOVERY_ATTEMPTS = 2;

function shouldAttemptGuardiaRecovery({ rejectingVeredictos, attemptsUsed = 0, maxAttempts = MAX_GUARDIA_RECOVERY_ATTEMPTS } = {}) {
  if (attemptsUsed >= maxAttempts) return false;
  return Array.isArray(rejectingVeredictos) && rejectingVeredictos.length > 0;
}

// Corrective note GENERAL: todos los problemas reportados (no solo
// fidelidad/coherencia), más — si la extracción de hechos encontró
// afirmaciones sin respaldo — una sección aparte con instrucción explícita
// de ELIMINAR el hecho inventado (distinto de "aclarar a cuál evento se
// refiere", que es la instrucción para ambigüedad). Pura, testeada.
function buildGuardiaCorrectiveNote(rejectingVeredictos, hechosSinRespaldo) {
  const detalles = [];
  for (const v of rejectingVeredictos || []) {
    for (const p of v?.problemas || []) {
      if (p.detalle) {
        const ubicacion = p.seccion ? `[${p.seccion}${p.linea > 0 ? ` línea ${p.linea}` : ''}] ` : '';
        detalles.push(`${ubicacion}(${p.tipo}/${p.gravedad}) ${p.detalle}`);
      }
    }
  }
  const unicos = [...new Set(detalles)];
  const lines = [
    'CORRECCIÓN OBLIGATORIA — un revisor independiente (El Guardia) marcó estos problemas concretos en el intento anterior:',
    ...unicos.map((d) => `- ${d}`),
  ];
  if (hechosSinRespaldo?.sinRespaldo?.length) {
    lines.push(
      'ADEMÁS, estas afirmaciones NO tienen respaldo en la encuesta — esto es INVENCIÓN real, no ambigüedad: ELIMINALAS o reemplazalas por algo que la encuesta sí diga, nunca por otro dato inventado:'
    );
    for (const h of hechosSinRespaldo.sinRespaldo) lines.push(`- (${h.tipo}) "${h.valor}" — ${h.motivo}`);
  }
  lines.push(
    'Para cada problema de AMBIGÜEDAD (un pronombre genérico que podría referirse a dos eventos similares), nombrá el lugar o la fecha exacto en esa línea. Para cada problema de INVENCIÓN, eliminá el hecho. No cambies el resto de la canción más de lo necesario.'
  );
  return lines.join('\n');
}

module.exports = {
  buildGuardiaPrompt,
  parseGuardiaResponse,
  validarGuardia,
  decideFactGateAction,
  shouldAttemptGuardiaRecovery,
  buildGuardiaCorrectiveNote,
  MAX_GUARDIA_RECOVERY_ATTEMPTS,
  shouldAttemptAmbiguityRecovery,
  buildAmbiguityCorrectiveNote,
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
