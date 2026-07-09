// lib/song-corrector.js — corrector barato de líneas puntuales.
//
// Cuando hardValidate() falla SOLO por problemas mecánicos y localizables
// (dígito, puntuación prohibida, frase incoherente conocida, palabra repetida
// en líneas consecutivas — ver isSafeToPatch()/patchableIssues en
// lib/song-validate.js), no hace falta pagarle al modelo caro (Sonnet) para
// que reescriba la canción entera. Le mandamos a un modelo barato (Haiku)
// SOLO las líneas puntuales a arreglar + el motivo — nunca el SYSTEM_PROMPT
// completo, es justamente lo que hace barato este camino.
//
// Este módulo NUNCA es la única red de seguridad: el caller (run.js) siempre
// re-valida el resultado con hardValidate() después del parche, y si algo
// sigue sin pasar, cae al regen completo existente sin romper nada.

const { isRetryableHttpStatus } = require('./http-retry');

const LYRICS_SECTION_KEYS = ['Verse 1', 'Chorus 1', 'Verse 2', 'Chorus 2', 'Bridge', 'Outro'];

function buildPatchSchema() {
  const properties = {};
  for (const sec of LYRICS_SECTION_KEYS) {
    properties[sec] = { type: 'array', items: { type: 'string' } };
  }
  return {
    type: 'object',
    properties: {
      letras: {
        type: 'object',
        properties,
        required: LYRICS_SECTION_KEYS,
        additionalProperties: false,
      },
    },
    required: ['letras'],
    additionalProperties: false,
  };
}

// parsedJson: objeto completo de la canción (titulo, voz, trato, estiloSuno,
// letras, qaChecklist, foneticaAplicada, advertencias).
// patchableIssues: [{ section, lineIndex, kind, detail }] — ver hardValidate().
// Devuelve una COPIA de parsedJson con "letras" reemplazado por la versión
// parcheada; todos los demás campos quedan intactos. Lanza si la API falla o
// la respuesta no es JSON válido — el caller decide qué hacer (siempre cae al
// regen completo si esto lanza).
async function patchSongLines(parsedJson, patchableIssues) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('ANTHROPIC_API_KEY no está configurada.');
    err.noRetry = true;
    throw err;
  }
  if (!patchableIssues || patchableIssues.length === 0) {
    throw new Error('patchSongLines: no hay patchableIssues para corregir.');
  }

  const instructions = patchableIssues
    .map((issue) => {
      const line = parsedJson.letras?.[issue.section]?.[issue.lineIndex];
      return `- [${issue.section}] línea ${issue.lineIndex + 1} (texto actual: "${line ?? ''}"): ${issue.detail}`;
    })
    .join('\n');

  const prompt = `Esta letra de canción es correcta en todo excepto por errores mecánicos puntuales en algunas líneas específicas. NO reescribas nada más — cambiá ÚNICAMENTE las líneas listadas abajo, preservando el sentido, la rima y el tono de cada sección. Cada sección debe mantener exactamente la misma cantidad de líneas que tiene ahora.

Letra completa actual (JSON, clave = sección, valor = array de líneas):
${JSON.stringify(parsedJson.letras, null, 2)}

Líneas a corregir y motivo:
${instructions}

Devolvé el objeto "letras" completo (las 6 secciones), con todas las líneas no listadas arriba intactas, palabra por palabra, y solo las listadas corregidas.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 4096,
      thinking: { type: 'disabled' },
      output_config: {
        format: { type: 'json_schema', schema: buildPatchSchema() },
      },
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = new Error(`Anthropic API error (corrector) ${response.status}: ${await response.text()}`);
    if (!isRetryableHttpStatus(response.status)) {
      err.noRetry = true;
    }
    throw err;
  }

  const data = await response.json();
  const text = data.content.map((block) => block.text || '').join('').trim();
  const patched = JSON.parse(text);

  if (!patched.letras) {
    throw new Error('El corrector no devolvió "letras" en la respuesta.');
  }

  return { ...parsedJson, letras: patched.letras };
}

module.exports = { patchSongLines, buildPatchSchema, LYRICS_SECTION_KEYS };
