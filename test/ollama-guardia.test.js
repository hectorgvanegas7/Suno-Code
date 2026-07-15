// test/ollama-guardia.test.js — Suite de regresión local para
// lib/ollama-guardia.js ("El Guardia").
//
// 100% offline: nunca llama a la API real de Anthropic — `validarGuardia`
// acepta `fetchImpl` inyectable y acá se le pasan respuestas fake con el
// mismo shape que POST /v1/messages devuelve
// ({ content: [{ type: 'text', text: '<json>' }] }).
// El nombre del archivo quedó de la época de Ollama (migrado a Claude Haiku
// 2026-07-14, ver LESSONS.md) — no se renombró para no romper imports.
// Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildGuardiaPrompt,
  parseGuardiaResponse,
  validarGuardia,
  formatGuardiaProblem,
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
  confianza: 7,
  estiloCoincide: true,
  problemas: [{ seccion: 'Verse 2', linea: 1, tipo: 'rima', gravedad: 'baja', detalle: 'rima pobre con la línea 3' }],
  veredicto: 'Letra sólida, con una rima floja en Verse 2.',
  aprobada: true,
};

// `content` es el string de texto que la API real devuelve dentro de
// content[0].text (normalmente JSON.stringify de la respuesta esperada).
// Para simular un error HTTP, pasá cualquier string en `content` — solo el
// `status` importa en ese caso (el código arma el mensaje de error con
// response.text(), nunca parsea el body de error como JSON).
function fakeAnthropicFetch(content, { status = 200 } = {}) {
  const isSuccess = status >= 200 && status < 300;
  const body = isSuccess ? { content: [{ type: 'text', text: content }] } : { error: content };
  return async () => ({
    ok: isSuccess,
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

test('buildGuardiaPrompt: incluye el estiloSuno pedido y pide juzgar si coincide con la encuesta', () => {
  const prompt = buildGuardiaPrompt({ letras: LETRAS_FAKE, titulo: 'T', survey: 'S', estiloSuno: 'Balada, piano suave, Latin American Spanish, neutral accent, seseo' });
  assert.match(prompt, /ESTILO PEDIDO A SUNO/);
  assert.match(prompt, /Balada, piano suave/);
  assert.match(prompt, /estiloCoincide/);
});

test('buildGuardiaPrompt: sin estiloSuno no lanza y lo dice explícitamente', () => {
  const prompt = buildGuardiaPrompt({ letras: LETRAS_FAKE, titulo: 'T', survey: 'S' });
  assert.match(prompt, /sin estilo especificado/);
});

test('parseGuardiaResponse: confianza se normaliza (clamp 1-10) y es opcional (null si falta, sin invalidar el veredicto)', () => {
  const con = parseGuardiaResponse(JSON.stringify({ ...RESPUESTA_VALIDA, confianza: 99 }));
  assert.equal(con.ok, true);
  assert.equal(con.confianza, 10);
  const { confianza, ...sinConfianza } = RESPUESTA_VALIDA;
  const sin = parseGuardiaResponse(JSON.stringify(sinConfianza));
  assert.equal(sin.ok, true);
  assert.equal(sin.confianza, null);
});

test('parseGuardiaResponse: estiloCoincide es boolean o null (respuestas viejas sin el campo no se invalidan)', () => {
  const con = parseGuardiaResponse(JSON.stringify({ ...RESPUESTA_VALIDA, estiloCoincide: false }));
  assert.equal(con.ok, true);
  assert.equal(con.estiloCoincide, false);
  const { estiloCoincide, ...sinEstilo } = RESPUESTA_VALIDA;
  const sin = parseGuardiaResponse(JSON.stringify(sinEstilo));
  assert.equal(sin.ok, true);
  assert.equal(sin.estiloCoincide, null);
});

test('parseGuardiaResponse: problemas estructurado — normaliza tipo/gravedad inválidos a defaults y descarta ítems sin detalle', () => {
  const r = parseGuardiaResponse(JSON.stringify({
    ...RESPUESTA_VALIDA,
    problemas: [
      { seccion: 'Bridge', linea: 2, tipo: 'algo-raro', gravedad: 'catastrofica', detalle: 'tipo/gravedad inválidos se normalizan' },
      { detalle: 'sin sección ni línea — es válido, aplica a toda la canción' },
      { seccion: 'Outro' }, // sin detalle: se descarta
      'problema en formato legado (string libre)',
      42, // basura: se descarta
    ],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.problemas.length, 3, `esperaba 3 problemas válidos, hubo ${r.problemas.length}: ${JSON.stringify(r.problemas)}`);
  assert.equal(r.problemas[0].tipo, 'otro', 'tipo fuera del enum se normaliza a "otro"');
  assert.equal(r.problemas[0].gravedad, 'media', 'gravedad fuera del enum se normaliza a "media"');
  assert.equal(r.problemas[1].seccion, '');
  assert.equal(r.problemas[1].linea, 0);
  assert.equal(r.problemas[2].tipo, 'otro');
  assert.equal(r.problemas[2].detalle, 'problema en formato legado (string libre)', 'un string suelto se envuelve como problema válido');
});

test('formatGuardiaProblem: arma un string legible con sección/línea solo si aplican', () => {
  assert.equal(
    formatGuardiaProblem({ seccion: 'Verse 2', linea: 3, tipo: 'rima', gravedad: 'alta', detalle: 'no rima con nada' }),
    '[Verse 2 línea 3] (rima/alta) no rima con nada'
  );
  assert.equal(
    formatGuardiaProblem({ seccion: '', linea: 0, tipo: 'tono', gravedad: 'media', detalle: 'tono general disparejo' }),
    '(tono/media) tono general disparejo'
  );
  assert.equal(
    formatGuardiaProblem({ seccion: 'Bridge', linea: 0, tipo: 'otro', gravedad: 'baja', detalle: 'sin línea puntual' }),
    '[Bridge] (otro/baja) sin línea puntual'
  );
});

test('validarGuardia: manda los headers correctos de la API de Anthropic (x-api-key, anthropic-version)', async () => {
  let sentHeaders = null;
  let sentBody = null;
  const fetchImpl = async (url, opts) => {
    sentHeaders = opts.headers;
    sentBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(RESPUESTA_VALIDA) }] }), text: async () => '' };
  };
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  try {
    await validarGuardia({ letras: LETRAS_FAKE }, { fetchImpl });
    assert.equal(sentHeaders['x-api-key'], 'test-key');
    assert.equal(sentHeaders['anthropic-version'], '2023-06-01');
    assert.equal(sentBody.output_config.format.type, 'json_schema');
  } finally {
    process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test('validarGuardia: sin ANTHROPIC_API_KEY devuelve ok:false sin llamar a fetch', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  const prevKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await validarGuardia({ letras: LETRAS_FAKE }, { fetchImpl });
    assert.equal(r.ok, false);
    assert.match(r.error, /ANTHROPIC_API_KEY/);
    assert.equal(called, false);
  } finally {
    process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test('validarGuardia: la respuesta cruda de Anthropic viaja en `raw` (auditoría/calibración), incluso si el parseo falla', async () => {
  const okFetch = fakeAnthropicFetch(JSON.stringify(RESPUESTA_VALIDA));
  const r1 = await validarGuardia({ letras: LETRAS_FAKE }, { fetchImpl: okFetch });
  assert.equal(r1.raw, JSON.stringify(RESPUESTA_VALIDA));

  const badFetch = fakeAnthropicFetch('{"basura": true}');
  const r2 = await validarGuardia({ letras: LETRAS_FAKE }, { fetchImpl: badFetch });
  assert.equal(r2.ok, false);
  assert.equal(r2.raw, '{"basura": true}', 'sin raw, una respuesta mal tipada se pierde sin dejar evidencia');
});

test('validarGuardia: respuesta 200 con JSON válido devuelve ok:true con model y durationMs', async () => {
  const fetchImpl = fakeAnthropicFetch(JSON.stringify(RESPUESTA_VALIDA));
  const r = await validarGuardia({ letras: LETRAS_FAKE, titulo: 'T', survey: 'S' }, { fetchImpl, model: 'claude-haiku-4-5' });
  assert.equal(r.ok, true);
  assert.equal(r.model, 'claude-haiku-4-5');
  assert.equal(typeof r.durationMs, 'number');
  assert.equal(r.veredicto, RESPUESTA_VALIDA.veredicto);
});

test('validarGuardia: fetch rechaza (sin red / API caída) NO lanza — ok:false con el error', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed: ECONNREFUSED'); };
  const r = await validarGuardia({ letras: LETRAS_FAKE }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED/);
});

test('validarGuardia: non-2xx (modelo inválido / rate limit) NO lanza — ok:false con el status', async () => {
  const fetchImpl = fakeAnthropicFetch('model not found', { status: 404 });
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

test('validarGuardia: respuesta sin content[].text NO lanza', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ content: [] }), text: async () => '' });
  const r = await validarGuardia({ letras: LETRAS_FAKE }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error, /sin texto/);
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
  nombreCorrecto: true,
  problemas: [],
  veredicto: 'El contenido cantado coincide con la letra pedida, solo hay estilo libre de canto.',
  aprobada: true,
  prioridadRevision: '',
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

test('buildAudioGuardiaPrompt: pide prioridadRevision y menciona señales de fusión más allá de Levenshtein/NISQA', () => {
  const prompt = buildAudioGuardiaPrompt({
    titulo: 'T', letraPedida: 'letra', transcripcion: 't',
    señales: 'Levenshtein: 90% | loudness: -14 LUFS integrado | género de voz detectado: Masculina (esperado: Femenina, NO COINCIDE)',
  });
  assert.match(prompt, /prioridadRevision/);
  assert.match(prompt, /loudness/i);
  assert.match(prompt, /género de voz/i);
  assert.match(prompt, /NO COINCIDE/);
});

test('parseAudioGuardiaResponse: prioridadRevision es string (vacía por default si el modelo no la manda)', () => {
  const conCampo = parseAudioGuardiaResponse(JSON.stringify({ ...RESPUESTA_AUDIO_VALIDA, prioridadRevision: 'revisar el segundo 45' }));
  assert.equal(conCampo.ok, true);
  assert.equal(conCampo.prioridadRevision, 'revisar el segundo 45');
  const { prioridadRevision, ...sinCampo } = RESPUESTA_AUDIO_VALIDA;
  const sin = parseAudioGuardiaResponse(JSON.stringify(sinCampo));
  assert.equal(sin.ok, true);
  assert.equal(sin.prioridadRevision, '');
});

test('parseAudioGuardiaResponse: nombreCorrecto es boolean o null (respuestas viejas sin el campo no se invalidan)', () => {
  const conCampo = parseAudioGuardiaResponse(JSON.stringify({ ...RESPUESTA_AUDIO_VALIDA, nombreCorrecto: false }));
  assert.equal(conCampo.ok, true);
  assert.equal(conCampo.nombreCorrecto, false);
  const { nombreCorrecto, ...sinCampoObj } = RESPUESTA_AUDIO_VALIDA;
  const sinCampo = parseAudioGuardiaResponse(JSON.stringify(sinCampoObj));
  assert.equal(sinCampo.ok, true);
  assert.equal(sinCampo.nombreCorrecto, null);
});

test('evaluarAudioGuardia: respuesta 200 con JSON válido devuelve ok:true', async () => {
  const fetchImpl = fakeAnthropicFetch(JSON.stringify(RESPUESTA_AUDIO_VALIDA));
  const r = await evaluarAudioGuardia(
    { titulo: 'T', letraPedida: 'letra', transcripcion: 'transcripcion', señales: 'Levenshtein: 60%' },
    { fetchImpl, model: 'claude-haiku-4-5' }
  );
  assert.equal(r.ok, true);
  assert.equal(r.model, 'claude-haiku-4-5');
  assert.equal(r.aprobada, true);
});

test('evaluarAudioGuardia: API caída NO lanza — ok:false con el error', async () => {
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

// ── Extracción cerrada de hechos + comparación en código (2026-07-14) ───────
// Caso real "El Hombre De Mi Vida": el juicio de fidelidad del Guardia dio
// 10/10 a una letra con "Miami" inventado (verificado en vivo, incluso con
// prompt endurecido). La extracción cerrada + comparación EN CÓDIGO es el
// reemplazo: el LLM lista, el código decide.
const { parseExtraccionResponse, compararHechosConEncuesta, extraerHechosLetra, buildExtraccionPrompt } = require('../lib/ollama-guardia');

const SURVEY_HECHOS = 'el se fue de Cuba y a los 10 años yo vine también a Estados Unidos pero hace 16 años todo empezó un 13 de mayo. Tenía 14 años y yo 17. tenemos 3 hermosos nietos';

test('compararHechosConEncuesta: lugar inventado ("Miami") se marca sin respaldo — caso real 2026-07-14', () => {
  const { evaluados, sinRespaldo } = compararHechosConEncuesta(
    { lugares: ['Miami', 'Cuba', 'Estados Unidos'], personas: [], fechasOMomentos: [] },
    SURVEY_HECHOS,
    { firstNames: ['damian'] }
  );
  assert.equal(evaluados, 3);
  assert.equal(sinRespaldo.length, 1, `esperaba solo Miami sin respaldo: ${JSON.stringify(sinRespaldo)}`);
  assert.equal(sinRespaldo[0].valor, 'Miami');
});

test('compararHechosConEncuesta: fechas/edades en palabras respaldadas por dígitos de la encuesta ("trece de mayo" <- "13 de mayo")', () => {
  const { sinRespaldo } = compararHechosConEncuesta(
    { lugares: [], personas: [], fechasOMomentos: ['trece de mayo', 'diecisiete años', 'catorce años', 'tres nietos'] },
    SURVEY_HECHOS,
    { firstNames: [] }
  );
  assert.equal(sinRespaldo.length, 0, `nada debía quedar sin respaldo: ${JSON.stringify(sinRespaldo)}`);
});

test('compararHechosConEncuesta: momento temporal inventado entero ("un martes de octubre") se marca aunque no tenga mayúsculas', () => {
  const { sinRespaldo } = compararHechosConEncuesta(
    { lugares: [], personas: [], fechasOMomentos: ['un martes de octubre'] },
    SURVEY_HECHOS,
    { firstNames: [] }
  );
  assert.equal(sinRespaldo.length, 1);
  assert.equal(sinRespaldo[0].valor, 'un martes de octubre');
});

test('compararHechosConEncuesta: persona del destinatario y términos religiosos pasan; persona inventada se marca', () => {
  const { sinRespaldo } = compararHechosConEncuesta(
    { lugares: [], personas: ['Damian', 'Dios', 'Daniel'], fechasOMomentos: [] },
    SURVEY_HECHOS,
    { firstNames: ['damian'] }
  );
  assert.equal(sinRespaldo.length, 1, JSON.stringify(sinRespaldo));
  assert.equal(sinRespaldo[0].valor, 'Daniel');
});

test('parseExtraccionResponse: respuesta válida se normaliza; basura no lanza', () => {
  const ok = parseExtraccionResponse('{"lugares":["Miami"],"personas":[],"fechasOMomentos":["  trece de mayo "]}');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.lugares, ['Miami']);
  assert.deepEqual(ok.fechasOMomentos, ['trece de mayo']);
  assert.equal(parseExtraccionResponse('no es json').ok, false);
  assert.equal(parseExtraccionResponse('[1,2]').ok, false);
});

test('extraerHechosLetra: usa fetchImpl inyectable y nunca lanza ante error de red', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: '{"lugares":["Cuba"],"personas":["Damian"],"fechasOMomentos":[]}' }] }) });
  const r = await extraerHechosLetra({ letras: { 'Verse 1': ['línea'] }, titulo: 'T' }, { fetchImpl });
  assert.equal(r.ok, true);
  assert.deepEqual(r.lugares, ['Cuba']);

  const fetchBoom = async () => { throw new Error('ECONNREFUSED'); };
  const err = await extraerHechosLetra({ letras: { 'Verse 1': ['línea'] }, titulo: 'T' }, { fetchImpl: fetchBoom });
  assert.equal(err.ok, false);
  assert.match(err.error, /ECONNREFUSED/);
});

test('buildExtraccionPrompt: incluye la letra y pide listas sin juicio', () => {
  const prompt = buildExtraccionPrompt({ letras: { 'Verse 1': ['nos cruzó por Miami'] }, titulo: 'T' });
  assert.ok(prompt.includes('nos cruzó por Miami'));
  assert.ok(prompt.includes('NO evalúes'));
});

test('compararHechosConEncuesta: sustantivo común sin dato temporal ("la casa") NUNCA se marca — falso positivo real atrapado por el banco dorado (2026-07-14)', () => {
  // La letra buena de "El Hombre De Mi Vida" decía "la casa que hoy tenemos"
  // y la encuesta decía "hogar" — escenografía poética permitida por la
  // regla 2 del SYSTEM_PROMPT, jamás un hecho inventado.
  const { sinRespaldo } = compararHechosConEncuesta(
    { lugares: ['la casa'], personas: [], fechasOMomentos: ['la isla', 'el mar'] },
    SURVEY_HECHOS,
    { firstNames: [] }
  );
  assert.equal(sinRespaldo.length, 0, JSON.stringify(sinRespaldo));
});

test('compararHechosConEncuesta: dato temporal/numérico SIN respaldo sí se marca aunque venga en minúscula ("veinte años juntos" que la encuesta no dice)', () => {
  const { sinRespaldo } = compararHechosConEncuesta(
    { lugares: [], personas: [], fechasOMomentos: ['veinte años juntos'] },
    SURVEY_HECHOS,
    { firstNames: [] }
  );
  assert.equal(sinRespaldo.length, 1, JSON.stringify(sinRespaldo));
  assert.equal(sinRespaldo[0].valor, 'veinte años juntos');
});

// ─── decideFactGateAction: graduación del gate de hechos (2026-07-14) ─────────

const { decideFactGateAction } = require('../lib/ollama-guardia');

test('decideFactGateAction: default (sin env) es warn — el modo histórico informativo', () => {
  assert.equal(decideFactGateAction({ sinRespaldoCount: 3, mode: undefined }), 'warn');
  assert.equal(decideFactGateAction({ sinRespaldoCount: 3, mode: null }), 'warn');
});

test('decideFactGateAction: modo desconocido cae a warn (fail-safe, nunca a regen)', () => {
  assert.equal(decideFactGateAction({ sinRespaldoCount: 3, mode: 'yolo' }), 'warn');
});

test('decideFactGateAction: off apaga la señal aunque haya hechos sin respaldo', () => {
  assert.equal(decideFactGateAction({ sinRespaldoCount: 5, mode: 'off' }), 'off');
});

test('decideFactGateAction: sin hechos sin respaldo → pass (en warn y en regen)', () => {
  assert.equal(decideFactGateAction({ sinRespaldoCount: 0, mode: 'warn' }), 'pass');
  assert.equal(decideFactGateAction({ sinRespaldoCount: 0, mode: 'regen' }), 'pass');
});

test('decideFactGateAction: regen dispara con hechos sin respaldo y presupuesto disponible', () => {
  assert.equal(decideFactGateAction({ sinRespaldoCount: 1, mode: 'regen', regenCount: 0 }), 'regen');
  assert.equal(decideFactGateAction({ sinRespaldoCount: 1, mode: 'regen', regenCount: 1 }), 'regen');
});

test('decideFactGateAction: degradación automática tras 2 regens en la misma canción (protege la cola nocturna)', () => {
  assert.equal(decideFactGateAction({ sinRespaldoCount: 1, mode: 'regen', regenCount: 2 }), 'degrade-warn');
  assert.equal(decideFactGateAction({ sinRespaldoCount: 4, mode: 'regen', regenCount: 5 }), 'degrade-warn');
});

test('decideFactGateAction: el modo es case-insensitive (REGEN de un .env de Windows vale)', () => {
  assert.equal(decideFactGateAction({ sinRespaldoCount: 1, mode: 'REGEN', regenCount: 0 }), 'regen');
});
