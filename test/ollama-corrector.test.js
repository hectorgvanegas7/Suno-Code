// test/ollama-corrector.test.js — Suite de regresión local para
// lib/ollama-corrector.js (Corrector Fonético opcional, NO wireado en
// run.js — ver LESSONS.md "Reemplazo de LanguageTool por Ollama, revertido").
//
// 100% offline: nunca llama a Ollama real — `optimizeLyricsPhonetics` acepta
// `fetchImpl` inyectable y acá se le pasan respuestas fake con el mismo
// shape que /api/chat devuelve ({ message: { content: '<markdown>' } }).
// Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { optimizeLyricsPhonetics, onlyAccentsChanged } = require('../lib/ollama-corrector');

const SURVEY = 'Nombre: Antonio\nEstilo: Balada triste\nLugar: Madrid';

// Fixture que pasa hardValidate tal cual (mismo patrón que
// test/song-validate.test.js) — necesario porque optimizeLyricsPhonetics
// revalida con hardValidate después del guardarraíl de contenido.
const VALID_JSON = {
  titulo: 'Mi Canción Eterna',
  voz: 'Masculina',
  trato: 'tú',
  estiloSuno: 'Balada, piano suave, Latin American Spanish, neutral accent, seseo',
  letras: {
    'Verse 1': ['Una tarde tranquila el cielo se abrio', 'Recuerdo esa risa que jamas cambio', 'El tiempo pasaba lento y sereno', 'Algo en mi pecho supo que eras bueno'],
    'Chorus 1': ['Antonio, hoy te canto con todo mi amor', 'Gracias por darme siempre tu calor', 'Cada momento contigo brilla mejor', 'Eres mi orgullo y mi mayor honor'],
    'Verse 2': ['Despues de un turno largo volvias feliz', 'Sacabas fuerzas para hacernos reir', 'Cada tropiezo lo hiciste sentir', 'Como un paso mas hacia el porvenir'],
    'Chorus 2': ['Antonio, admiro tu fuerza y tu bondad', 'Marcaste mi vida con sinceridad', 'Nunca dude de tu generosidad', 'Eres ejemplo puro de humildad'],
    Bridge: ['Aquella noche me tomaste la mano', 'Y prometiste cuidar cada verano', 'Ese instante quedo grabado cercano', 'Fue la prueba de un amor soberano'],
    Outro: ['Hoy te prometo un cariño sincero', 'Seras mi guia por todo el sendero', 'Con esta cancion te digo primero', 'Te voy a amar por siempre entero'],
  },
  qaChecklist: {
    '6_secciones_en_orden': true, '4_lineas_por_seccion': true, 'nombre_primera_palabra_chorus': true,
    'nombre_solo_una_vez_por_chorus': true, 'nombre_ausente_en_verse_1': true, 'chorus_1_distinto_chorus_2': true,
    'verse_2_con_escena_concreta': true, 'bridge_con_detalle_vulnerable': true, 'nada_inventado': true,
    'trato_consistente': true, 'numeros_meses_completos': true, 'titulo_no_cantable': true,
    'sin_puntuacion_prohibida': true, 'sin_lineas_consecutivas_misma_palabra': true, 'todas_lineas_con_sentido': true,
    'estilo_suno_incluye_seseo': true, 'sin_dialogos_textuales': true, 'destinatarios_multiples_balanceados': true,
    'pov_consistente': true, 'sin_acrostico': true, 'metrica_corta_y_consistente': true, 'rima_fuerte_evidente': true,
    'adaptacion_poetica_sin_copypaste': true, 'coros_con_gancho': true, 'vocales_abiertas_en_coro': true,
  },
  advertencias: 'Ninguna',
  foneticaAplicada: false,
};

// Mismo texto que VALID_JSON pero con tildes agregadas — es la corrección
// "buena" que el corrector fonético debería producir.
const CORRECTED_MARKDOWN = `[Verse 1]
Una tarde tranquila el cielo se abrió
Recuerdo esa risa que jamás cambió
El tiempo pasaba lento y sereno
Algo en mi pecho supo que eras bueno

[Chorus 1]
Antonio, hoy te canto con todo mi amor
Gracias por darme siempre tu calor
Cada momento contigo brilla mejor
Eres mi orgullo y mi mayor honor

[Verse 2]
Después de un turno largo volvías feliz
Sacabas fuerzas para hacernos reír
Cada tropiezo lo hiciste sentir
Como un paso más hacia el porvenir

[Chorus 2]
Antonio, admiro tu fuerza y tu bondad
Marcaste mi vida con sinceridad
Nunca dudé de tu generosidad
Eres ejemplo puro de humildad

[Bridge]
Aquella noche me tomaste la mano
Y prometiste cuidar cada verano
Ese instante quedó grabado cercano
Fue la prueba de un amor soberano

[Outro]
Hoy te prometo un cariño sincero
Serás mi guía por todo el sendero
Con esta canción te digo primero
Te voy a amar por siempre entero`;

function fakeOllamaFetch(content) {
  return async () => ({
    ok: true,
    json: async () => ({ message: { content } }),
  });
}

test('onlyAccentsChanged: true cuando solo se agregan tildes/eñes', () => {
  const before = { 'Verse 1': ['una cancion muy triste'] };
  const after = { 'Verse 1': ['una canción muy triste'] };
  assert.equal(onlyAccentsChanged(before, after), true);
});

test('onlyAccentsChanged: false si una palabra cambia de identidad (bug real "Jenner"->"tener")', () => {
  const before = { 'Verse 1': ['la orilla del Jenner'] };
  const after = { 'Verse 1': ['la orilla del tener'] };
  assert.equal(onlyAccentsChanged(before, after), false);
});

test('onlyAccentsChanged: false si cambia el conteo de palabras (línea agregada/quitada)', () => {
  const before = { 'Verse 1': ['una linea corta'] };
  const after = { 'Verse 1': ['una linea corta y mas larga'] };
  assert.equal(onlyAccentsChanged(before, after), false);
});

test('optimizeLyricsPhonetics: corrección válida (solo tildes) pasa el guardarraíl y hardValidate', async () => {
  const fetchImpl = fakeOllamaFetch(CORRECTED_MARKDOWN);
  const result = await optimizeLyricsPhonetics(VALID_JSON, SURVEY, { fetchImpl });
  assert.equal(result.ok, true, result.error);
  assert.ok(result.parsedJson.letras['Verse 1'][1].includes('jamás'));
});

test('optimizeLyricsPhonetics: rechaza si Ollama cambia una palabra real (protección anti-"Jenner")', async () => {
  const corrupted = CORRECTED_MARKDOWN.replace('Antonio, hoy te canto', 'Roberto, hoy te canto');
  const fetchImpl = fakeOllamaFetch(corrupted);
  const result = await optimizeLyricsPhonetics(VALID_JSON, SURVEY, { fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /guardarraíl de contenido/);
});

test('optimizeLyricsPhonetics: respuesta vacía de Ollama se reporta como fallo, no se asume limpio', async () => {
  const fetchImpl = fakeOllamaFetch('');
  const result = await optimizeLyricsPhonetics(VALID_JSON, SURVEY, { fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /vacía/);
});

test('optimizeLyricsPhonetics: formato irreconocible (sin encabezados de sección) se reporta como fallo', async () => {
  const fetchImpl = fakeOllamaFetch('esto no tiene ningún encabezado de sección');
  const result = await optimizeLyricsPhonetics(VALID_JSON, SURVEY, { fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /formato irreconocible/);
});

test('optimizeLyricsPhonetics: Ollama caído (fetch rechaza) nunca se asume limpio', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed: ECONNREFUSED 127.0.0.1:11434'); };
  const result = await optimizeLyricsPhonetics(VALID_JSON, SURVEY, { fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /ECONNREFUSED/);
});

test('optimizeLyricsPhonetics: HTTP no-ok (modelo no encontrado, etc.) nunca se asume limpio', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  const result = await optimizeLyricsPhonetics(VALID_JSON, SURVEY, { fetchImpl });
  assert.equal(result.ok, false);
});
