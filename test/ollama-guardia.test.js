// test/ollama-guardia.test.js — Suite de regresión local para
// lib/ollama-guardia.js ("El Guardia").
//
// 100% offline: nunca llama a Ollama real — `validarGuardia` acepta
// `fetchImpl` inyectable y acá se le pasan respuestas fake con el mismo
// shape que /api/chat devuelve ({ message: { content: '<json>' } }).
// Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildGuardiaPrompt,
  parseGuardiaResponse,
  validarGuardia,
  LYRICS_SECTION_KEYS,
  buildAudioGuardiaPrompt,
  parseAudioGuardiaResponse,
  evaluarAudioGuardia,
} = require('../lib/ollama-guardia');

const LETRAS_FAKE = {
  'Verse 1': ['Línea uno', 'Línea dos'],
  'Chorus 1': ['Susana canta'],
  'Verse 2': ['Otra línea'],
  'Chorus 2': ['Susana brilla'],
  'Bridge': ['Puente'],
  'Outro': ['Cierre'],
};

const RESPUESTA_VALIDA = {
  coherencia: 8,
  rima: 7,
  tono: 9,
  fidelidad: 8,
  gancho: 6,
  problemas: ['[Verse 2] línea 1: rima pobre con la línea 3'],
  veredicto: 'Letra sólida, con una rima floja en Verse 2.',
  aprobada: true,
};

function fakeOllamaFetch(body, { status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

test('buildGuardiaPrompt: incluye las 6 secciones en orden, el título y la encuesta', () => {
  const prompt = buildGuardiaPrompt({ letras: LETRAS_FAKE, titulo: 'Mi Canción', survey: 'Historia del cliente acá' });
  let lastIndex = -1;
  for (const key of LYRICS_SECTION_KEYS) {
    const idx = prompt.indexOf(`[${key}]`);
    assert.ok(idx > lastIndex, `sección ${key} ausente o fuera de orden (idx=${idx}, anterior=${lastIndex})`);
    lastIndex = idx;
  }
  assert.match(prompt, /Mi Canción/);
  assert.match(prompt, /Historia del cliente acá/);
  assert.match(prompt, /fidelidad/, 'el rubro de fidelidad a la encuesta debe estar en el prompt');
});

test('buildGuardiaPrompt: sin encuesta ni título no lanza y lo dice explícitamente', () => {
  const prompt = buildGuardiaPrompt({ letras: LETRAS_FAKE });
  assert.match(prompt, /sin encuesta disponible/);
  assert.match(prompt, /sin título/);
});

test('parseGuardiaResponse: JSON válido devuelve todos los campos normalizados', () => {
  const r = parseGuardiaResponse(JSON.stringify(RESPUESTA_VALIDA));
  assert.equal(r.ok, true);
  assert.equal(r.coherencia, 8);
  assert.equal(r.gancho, 6);
  assert.deepEqual(r.problemas, RESPUESTA_VALIDA.problemas);
  assert.equal(r.aprobada, true);
});

test('parseGuardiaResponse: puntajes fuera de rango se acotan a 1-10 en vez de propagarse', () => {
  const r = parseGuardiaResponse(JSON.stringify({ ...RESPUESTA_VALIDA, coherencia: 99, rima: 0 }));
  assert.equal(r.ok, true);
  assert.equal(r.coherencia, 10);
  assert.equal(r.rima, 1);
});

test('parseGuardiaResponse: JSON malformado o incompleto no lanza — devuelve ok:false con motivo', () => {
  assert.equal(parseGuardiaResponse('esto no es json {').ok, false);
  assert.equal(parseGuardiaResponse('[1,2,3]').ok, false);
  const sinPuntaje = parseGuardiaResponse(JSON.stringify({ ...RESPUESTA_VALIDA, rima: 'alta' }));
  assert.equal(sinPuntaje.ok, false);
  assert.match(sinPuntaje.error, /rima/);
});

test('parseGuardiaResponse: problemas no-array y veredicto vacío degradan a defaults seguros', () => {
  const r = parseGuardiaResponse(JSON.stringify({ ...RESPUESTA_VALIDA, problemas: 'no soy array', veredicto: '  ' }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.problemas, []);
  assert.equal(r.veredicto, '(sin veredicto)');
});

test('buildGuardiaPrompt con qaContext: la pasada informada incluye los fallos del QA duro y pide juicio propio', () => {
  const prompt = buildGuardiaPrompt({
    letras: LETRAS_FAKE,
    titulo: 'T',
    survey: 'S',
    qaContext: { passedQA: false, failures: ['Eñe/tilde perdida: [Chorus 1] línea 1 contiene "maria"'] },
  });
  assert.match(prompt, /QA AUTOMÁTICO PREVIO/);
  assert.match(prompt, /contiene "maria"/);
  assert.match(prompt, /NO pasó la validación automática/);
  assert.match(prompt, /no apruebes ni rechaces solo porque el validador/i, 'debe pedir juicio propio, no eco del validador');
});

test('buildGuardiaPrompt sin qaContext (pasada ciega): NO menciona el QA previo — juicio independiente', () => {
  const prompt = buildGuardiaPrompt({ letras: LETRAS_FAKE, titulo: 'T', survey: 'S' });
  assert.ok(!prompt.includes('QA AUTOMÁTICO PREVIO'), 'la pasada ciega no debe ver los fallos del validador');
});

test('parseGuardiaResponse: confianza se normaliza (clamp 1-10) y es opcional (null si falta, sin invalidar el veredicto)', () => {
  const con = parseGuardiaResponse(JSON.stringify({ ...RESPUESTA_VALIDA, confianza: 99 }));
  assert.equal(con.ok, true);
  assert.equal(con.confianza, 10);
  const sin = parseGuardiaResponse(JSON.stringify(RESPUESTA_VALIDA));
  assert.equal(sin.ok, true);
  assert.equal(sin.confianza, null);
});

test('validarGuardia: keepAlive viaja al body de Ollama (entre pasadas consecutivas no se recarga el modelo desde frío)', async () => {
  let sentBody = null;
  const fetchImpl = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify(RESPUESTA_VALIDA) } }), text: async () => '' };
  };
  await validarGuardia({ letras: LETRAS_FAKE }, { fetchImpl, keepAlive: '5m' });
  assert.equal(sentBody.keep_alive, '5m');
  await validarGuardia({ letras: LETRAS_FAKE }, { fetchImpl });
  assert.equal(sentBody.keep_alive, 0, 'sin keepAlive explícito, el default sigue siendo 0 (libera VRAM)');
});

test('validarGuardia: la respuesta cruda de Ollama viaja en `raw` (auditoría/calibración), incluso si el parseo falla', async () => {
  const okFetch = fakeOllamaFetch({ message: { content: JSON.stringify(RESPUESTA_VALIDA) } });
  const r1 = await validarGuardia({ letras: LETRAS_FAKE }, { fetchImpl: okFetch });
  assert.equal(r1.raw, JSON.stringify(RESPUESTA_VALIDA));

  const badFetch = fakeOllamaFetch({ message: { content: '{"basura": true}' } });
  const r2 = await validarGuardia({ letras: LETRAS_FAKE }, { fetchImpl: badFetch });
  assert.equal(r2.ok, false);
  assert.equal(r2.raw, '{"basura": true}', 'sin raw, una respuesta mal tipada se pierde sin dejar evidencia');
});

test('validarGuardia: respuesta 200 con JSON válido devuelve ok:true con model y durationMs', async () => {
  const fetchImpl = fakeOllamaFetch({ message: { content: JSON.stringify(RESPUESTA_VALIDA) } });
  const r = await validarGuardia({ letras: LETRAS_FAKE, titulo: 'T', survey: 'S' }, { fetchImpl, model: 'qwen3:14b' });
  assert.equal(r.ok, true);
  assert.equal(r.model, 'qwen3:14b');
  assert.equal(typeof r.durationMs, 'number');
  assert.equal(r.veredicto, RESPUESTA_VALIDA.veredicto);
});

test('validarGuardia: Ollama caído (fetch rechaza) NO lanza — ok:false con el error', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed: ECONNREFUSED 127.0.0.1:11434'); };
  const r = await validarGuardia({ letras: LETRAS_FAKE }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED/);
});

test('validarGuardia: non-2xx (modelo no bajado) NO lanza — ok:false con el status', async () => {
  const fetchImpl = fakeOllamaFetch({ error: 'model "qwen3:14b" not found' }, { status: 404 });
  const r = await validarGuardia({ letras: LETRAS_FAKE }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error, /404/);
});

test('validarGuardia: timeout aborta y devuelve ok:false con pista de qué probar', async () => {
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const r = await validarGuardia({ letras: LETRAS_FAKE }, { fetchImpl, timeoutMs: 20 });
  assert.equal(r.ok, false);
  assert.match(r.error, /timeout de 20ms/);
});

test('validarGuardia: respuesta sin message.content NO lanza', async () => {
  const fetchImpl = fakeOllamaFetch({ done: true });
  const r = await validarGuardia({ letras: LETRAS_FAKE }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error, /message\.content/);
});

test('validarGuardia: sin letras devuelve ok:false sin siquiera llamar a fetch', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  const r = await validarGuardia({ letras: null }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

// ── Guardia de audio (falsos positivos de Levenshtein/NISQA sobre voz cantada) ──

const RESPUESTA_AUDIO_VALIDA = {
  coincideConLetra: true,
  similitud: 9,
  problemas: [],
  veredicto: 'El contenido cantado coincide con la letra pedida, solo hay estilo libre de canto.',
  aprobada: true,
};

test('buildAudioGuardiaPrompt: incluye título, letra pedida, transcripción y señales', () => {
  const prompt = buildAudioGuardiaPrompt({
    titulo: 'Un Ángel en Jenner',
    letraPedida: 'La arena estaba fría en la orilla del Jenner',
    transcripcion: 'la arena estaba fría en la oriya del yener',
    señales: 'Levenshtein: 59% | NISQA: 23/100',
  });
  assert.match(prompt, /Un Ángel en Jenner/);
  assert.match(prompt, /orilla del Jenner/);
  assert.match(prompt, /oriya del yener/);
  assert.match(prompt, /Levenshtein: 59%/);
  assert.match(prompt, /falsos positivos/i);
});

test('buildAudioGuardiaPrompt: sin datos no lanza y lo dice explícitamente', () => {
  const prompt = buildAudioGuardiaPrompt({});
  assert.match(prompt, /sin letra disponible/);
  assert.match(prompt, /sin transcripción disponible/);
  assert.match(prompt, /sin señales/);
});

test('parseAudioGuardiaResponse: JSON válido devuelve todos los campos normalizados', () => {
  const r = parseAudioGuardiaResponse(JSON.stringify(RESPUESTA_AUDIO_VALIDA));
  assert.equal(r.ok, true);
  assert.equal(r.coincideConLetra, true);
  assert.equal(r.similitud, 9);
  assert.equal(r.aprobada, true);
});

test('parseAudioGuardiaResponse: similitud fuera de rango se acota a 1-10', () => {
  const r = parseAudioGuardiaResponse(JSON.stringify({ ...RESPUESTA_AUDIO_VALIDA, similitud: 99 }));
  assert.equal(r.ok, true);
  assert.equal(r.similitud, 10);
});

test('parseAudioGuardiaResponse: JSON malformado o sin similitud no lanza — ok:false', () => {
  assert.equal(parseAudioGuardiaResponse('no es json {').ok, false);
  const sinSimilitud = parseAudioGuardiaResponse(JSON.stringify({ ...RESPUESTA_AUDIO_VALIDA, similitud: 'alta' }));
  assert.equal(sinSimilitud.ok, false);
  assert.match(sinSimilitud.error, /similitud/);
});

test('buildAudioGuardiaPrompt con nombres: pide el chequeo específico de nombreCorrecto con los nombres reales', () => {
  const prompt = buildAudioGuardiaPrompt({
    titulo: 'T', letraPedida: 'letra', transcripcion: 't', señales: 's',
    nombres: ['Clara', 'Mateo'],
  });
  assert.match(prompt, /nombreCorrecto/);
  assert.match(prompt, /Clara, Mateo/);
  assert.match(prompt, /error más caro del negocio/i);
});

test('parseAudioGuardiaResponse: nombreCorrecto es boolean o null (respuestas viejas sin el campo no se invalidan)', () => {
  const conCampo = parseAudioGuardiaResponse(JSON.stringify({ ...RESPUESTA_AUDIO_VALIDA, nombreCorrecto: false }));
  assert.equal(conCampo.ok, true);
  assert.equal(conCampo.nombreCorrecto, false);
  const sinCampo = parseAudioGuardiaResponse(JSON.stringify(RESPUESTA_AUDIO_VALIDA));
  assert.equal(sinCampo.ok, true);
  assert.equal(sinCampo.nombreCorrecto, null);
});

test('evaluarAudioGuardia: respuesta 200 con JSON válido devuelve ok:true', async () => {
  const fetchImpl = fakeOllamaFetch({ message: { content: JSON.stringify(RESPUESTA_AUDIO_VALIDA) } });
  const r = await evaluarAudioGuardia(
    { titulo: 'T', letraPedida: 'letra', transcripcion: 'transcripcion', señales: 'Levenshtein: 60%' },
    { fetchImpl, model: 'qwen3:14b' }
  );
  assert.equal(r.ok, true);
  assert.equal(r.model, 'qwen3:14b');
  assert.equal(r.aprobada, true);
});

test('evaluarAudioGuardia: Ollama caído NO lanza — ok:false con el error', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed: ECONNREFUSED'); };
  const r = await evaluarAudioGuardia({ letraPedida: 'letra' }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED/);
});

test('evaluarAudioGuardia: sin letra pedida devuelve ok:false sin llamar a fetch', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  const r = await evaluarAudioGuardia({ letraPedida: null }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});
