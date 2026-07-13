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
const GUARDIA_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    coherencia: { type: 'integer', minimum: 1, maximum: 10 },
    rima: { type: 'integer', minimum: 1, maximum: 10 },
    tono: { type: 'integer', minimum: 1, maximum: 10 },
    fidelidad: { type: 'integer', minimum: 1, maximum: 10 },
    gancho: { type: 'integer', minimum: 1, maximum: 10 },
    problemas: { type: 'array', items: { type: 'string' } },
    veredicto: { type: 'string' },
    aprobada: { type: 'boolean' },
  },
  required: ['coherencia', 'rima', 'tono', 'fidelidad', 'gancho', 'problemas', 'veredicto', 'aprobada'],
};

// Arma el prompt de evaluación. Pura — testeable sin red. Incluye la
// encuesta (la historia REAL que la letra debe honrar) para que `fidelidad`
// sea una segunda opinión independiente sobre "nada_inventado", que hoy
// solo se autoevalúa el modelo generador.
function buildGuardiaPrompt({ letras, titulo, survey }) {
  const seccionesTexto = LYRICS_SECTION_KEYS
    .map((key) => `[${key}]\n${(letras[key] || []).join('\n')}`)
    .join('\n\n');

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
    '=== QUÉ EVALUAR (cada puntaje de 1 a 10) ===',
    '- coherencia: ¿cada línea tiene sentido en español y las secciones cuentan una historia que avanza (Verse 1 → Outro)?',
    '- rima: ¿la rima es rica y consistente, o pobre/forzada/inexistente?',
    '- tono: ¿el tono emocional coincide con la ocasión de la encuesta?',
    '- fidelidad: ¿la letra usa los datos reales de la historia del cliente SIN inventar hechos que no están en la encuesta?',
    '- gancho: ¿el coro tiene una línea memorable y cantable?',
    '- problemas: lista de problemas CONCRETOS, cada uno indicando sección y línea (ej. "[Verse 2] línea 3: ..."). Lista vacía si no hay.',
    '- veredicto: una sola frase resumen en español.',
    '- aprobada: true solo si mandarías esta letra a producción sin tocarla.',
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

  return {
    ok: true,
    ...scores,
    problemas: Array.isArray(data.problemas) ? data.problemas.filter((p) => typeof p === 'string') : [],
    veredicto: typeof data.veredicto === 'string' && data.veredicto.trim() ? data.veredicto.trim() : '(sin veredicto)',
    aprobada: data.aprobada === true,
  };
}

// Llama al Guardia. NUNCA lanza: { ok: false, error } ante cualquier fallo
// (Ollama no instalado/no corriendo, timeout, non-2xx, JSON inválido) — el
// caller (run.js) sigue de largo sin señal esta vez, igual que el gate de
// LanguageTool cuando el servicio no responde. keep_alive: 0 es obligatorio:
// descarga el modelo de VRAM apenas responde, para no pisarle los 8GB al
// pipeline de audio (Whisper/Demucs/CLAP/NISQA) de la misma corrida.
async function validarGuardia(
  { letras, titulo, survey },
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

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: buildGuardiaPrompt({ letras, titulo, survey }) }],
        stream: false,
        format: GUARDIA_RESPONSE_SCHEMA,
        keep_alive: 0,
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
    if (!parsed.ok) return parsed;

    return { ...parsed, model, durationMs: Date.now() - startedAt };
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
// perfecto. Se llama SOLO cuando ya hay una señal de alarma numérica (ver
// verify-audio.js) para no gastar Ollama en cada canción sana.
//
// PURAMENTE INFORMATIVO como el resto de esta Capa 3, mismo criterio de
// "nunca bloquea, nunca lanza, no calibrado en vivo todavía" — ver
// LESSONS.md para la discusión de si algún día pasa a gate real.
const AUDIO_GUARDIA_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    coincideConLetra: { type: 'boolean' },
    similitud: { type: 'integer', minimum: 1, maximum: 10 },
    problemas: { type: 'array', items: { type: 'string' } },
    veredicto: { type: 'string' },
    aprobada: { type: 'boolean' },
  },
  required: ['coincideConLetra', 'similitud', 'problemas', 'veredicto', 'aprobada'],
};

// Pura — testeable sin red.
function buildAudioGuardiaPrompt({ titulo, letraPedida, transcripcion, señales }) {
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
    '=== SEÑALES AUTOMÁTICAS (de referencia, no decidas solo con esto) ===',
    señales || '(sin señales)',
    '',
    'Tu trabajo: comparar SEMÁNTICAMENTE la transcripción contra la letra pedida y decidir si esta versión suena a que Suno cantó la canción correcta, o si hay una alucinación REAL (versos inventados de otro tema, nombre del destinatario equivocado, corte grave de contenido, tema completamente distinto al pedido).',
    '- coincideConLetra: true si el contenido cantado corresponde razonablemente a la letra pedida (tolerando imperfecciones normales de transcripción de canto).',
    '- similitud: 1-10, tu propio juicio de fidelidad real de CONTENIDO (no repitas el número de Levenshtein/NISQA que te pasé).',
    '- problemas: lista de problemas REALES y concretos si los hay (vacía si no hay ninguno).',
    '- veredicto: una frase resumen en español.',
    '- aprobada: true si mandarías este audio a un cliente real sin dudarlo.',
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
    coincideConLetra: data.coincideConLetra === true,
    similitud: Math.min(10, Math.max(1, Math.round(similitud))),
    problemas: Array.isArray(data.problemas) ? data.problemas.filter((p) => typeof p === 'string') : [],
    veredicto: typeof data.veredicto === 'string' && data.veredicto.trim() ? data.veredicto.trim() : '(sin veredicto)',
    aprobada: data.aprobada === true,
  };
}

// Mismo contrato que validarGuardia: NUNCA lanza, { ok: false, error } ante
// cualquier fallo, keep_alive: 0 para no pisarle VRAM al pipeline de audio.
async function evaluarAudioGuardia(
  { titulo, letraPedida, transcripcion, señales },
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

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: buildAudioGuardiaPrompt({ titulo, letraPedida, transcripcion, señales }) }],
        stream: false,
        format: AUDIO_GUARDIA_RESPONSE_SCHEMA,
        keep_alive: 0,
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
    if (!parsed.ok) return parsed;

    return { ...parsed, model, durationMs: Date.now() - startedAt };
  } catch (e) {
    const error = e.name === 'AbortError'
      ? `timeout de ${timeoutMs}ms esperando al Guardia de audio (¿modelo cargando por primera vez? ¿probar GUARDIA_MODEL=qwen3:8b?)`
      : e.message;
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  buildGuardiaPrompt,
  parseGuardiaResponse,
  validarGuardia,
  GUARDIA_RESPONSE_SCHEMA,
  buildAudioGuardiaPrompt,
  parseAudioGuardiaResponse,
  evaluarAudioGuardia,
  AUDIO_GUARDIA_RESPONSE_SCHEMA,
  LYRICS_SECTION_KEYS,
  DEFAULT_MODEL,
};
