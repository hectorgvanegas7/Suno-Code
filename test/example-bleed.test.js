// test/example-bleed.test.js — Regresión del detector de calcos del ejemplo
// dorado (lib/example-bleed.js). Caso real que lo motivó (2026-07-15): la
// canción "Keyla" abrió el Bridge con "cuando ya no esté para decirlo de
// frente" — casi calco del Bridge del ejemplo ("Cuando ya no esté para
// decirlo con mi voz"), la misma noche en que el ejemplo entró al prompt.
// 100% offline (exampleLines inyectadas — no depende de golden/ en disco).
// Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { findExampleBleed, lineSimilarity, parseExampleLines } = require('../lib/example-bleed');

const EXAMPLE_LINES = [
  'Cuando ya no esté para decirlo con mi voz',
  'Le doy gracias a Dios por el hogar que construimos',
  'Aquel mar que separaba ya no existe más',
  'Damian, la casa que hoy tenemos habla por los dos',
];

const song = (bridgeLine) => ({
  'Verse 1': ['una pantalla azul en la noche encendida', 'letras que armaban una voz desconocida', 'un cuarto de chat donde el tiempo paraba', 'mi corazón sin verte ya te esperaba'],
  'Bridge': [bridgeLine, 'quiero que recuerdes esa noche de internet', 'le pedí una señal y llegaste tú sola', 'ahora entiendo que rezaba sin saberlo'],
});

test('detecta el calco REAL de Keyla: mismo arranque de Bridge que el ejemplo (n-grama de 5+)', () => {
  const findings = findExampleBleed(song('cuando ya no esté para decirlo de frente'), 'encuesta sin nada relacionado', { exampleLines: EXAMPLE_LINES });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].seccion, 'Bridge');
  assert.equal(findings[0].linea, 1);
  assert.match(findings[0].motivo, /palabras consecutivas/);
});

test('una canción sin relación con el ejemplo pasa limpia', () => {
  const findings = findExampleBleed(song('si un día las dudas tocan a tu puerta'), 'encuesta cualquiera', { exampleLines: EXAMPLE_LINES });
  assert.deepEqual(findings, []);
});

test('n-grama compartido que la ENCUESTA contiene NO es calco (material legítimo del cliente)', () => {
  // "le doy gracias a dios por" está en el ejemplo Y en esta encuesta — el
  // cliente lo dijo, así que la letra tiene derecho a usarlo.
  const letras = { 'Outro': ['le doy gracias a Dios por cada mañana contigo', 'y por el café que compartimos', 'la vida nos juntó despacio', 'y aquí seguimos caminando'] };
  const surveyWith = 'Special message: le doy gracias a dios por mi esposo y por todo lo que vivimos';
  assert.deepEqual(findExampleBleed(letras, surveyWith, { exampleLines: EXAMPLE_LINES }), []);
  // La MISMA letra sin ese respaldo en la encuesta SÍ se marca.
  const sinRespaldo = findExampleBleed(letras, 'encuesta que no menciona nada de eso', { exampleLines: EXAMPLE_LINES });
  assert.equal(sinRespaldo.length, 1);
});

test('similitud de línea completa atrapa reescrituras con las mismas palabras en otro orden', () => {
  const letras = { 'Outro': ['ya no existe más aquel mar que separaba'] };
  const findings = findExampleBleed(letras, '', { exampleLines: EXAMPLE_LINES });
  assert.equal(findings.length, 1);
  assert.match(findings[0].motivo, /similitud/);
});

test('lineSimilarity: idénticas=1, sin relación≈0', () => {
  assert.equal(lineSimilarity('hola mi amor', 'hola mi amor'), 1);
  assert.ok(lineSimilarity('una pantalla azul encendida', 'tres nietos llenan la mesa') < 0.2);
});

test('parseExampleLines extrae solo las líneas cantables del formato song.txt', () => {
  const content = '**Título:** X\n\n---\n\n[Verse 1]\nlinea uno\nlinea dos\n\n[Chorus 1]\nlinea tres\n\n---\n\n**QA Checklist:**\n- item: ✓';
  assert.deepEqual(parseExampleLines(content), ['linea uno', 'linea dos', 'linea tres']);
});

test('sin líneas de ejemplo el chequeo queda desactivado (nunca rompe la generación)', () => {
  assert.deepEqual(findExampleBleed(song('cuando ya no esté para decirlo de frente'), '', { exampleLines: [] }), []);
});
