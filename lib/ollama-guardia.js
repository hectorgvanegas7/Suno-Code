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

module.exports = {
  buildGuardiaPrompt,
  parseGuardiaResponse,
  validarGuardia,
  GUARDIA_RESPONSE_SCHEMA,
  LYRICS_SECTION_KEYS,
  DEFAULT_MODEL,
};
