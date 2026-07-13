// test/text-helpers.test.js — Suite de regresión local para lib/text-helpers.js.
//
// 100% offline: no llama a ninguna API ni abre Chrome. Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractFirstNames, extractLyricNameVariants, extractSurveyProperNouns } = require('../lib/text-helpers');

test('extractFirstNames: nombre simple', () => {
  const names = extractFirstNames("What's their name?: Frank");
  assert.deepEqual(names, ['frank']);
});

test('extractFirstNames: multi-destinatario filtra palabras de relleno', () => {
  const names = extractFirstNames("What's their name?: Mis hijos Christopher y Soraya.");
  assert.deepEqual(names, ['christopher', 'soraya']);
});

const buildLyricsWithChoruses = (chorus1Opener, chorus2Opener) => `[Verse 1]
Una tarde tranquila el cielo se abrió
Recuerdo esa risa que jamás cambió
El tiempo pasaba lento y sereno
Algo en mi pecho supo que eras bueno

[Chorus 1]
${chorus1Opener}, hoy te canto con todo mi amor
Gracias por darme siempre tu calor
Cada momento contigo brilla mejor
Eres mi orgullo y mi mayor honor

[Verse 2]
Después de un turno largo volvías feliz
Sacabas fuerzas para hacernos reír
Cada tropiezo lo hiciste sentir
Como un paso más hacia el porvenir

[Chorus 2]
${chorus2Opener}, admiro tu fuerza y tu bondad
Marcaste mi vida con sinceridad
Nunca dudé de tu generosidad
Sos ejemplo puro de humanidad

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

test('extractLyricNameVariants: single-recipient acepta respelling fonético aunque cambie la primera letra (Jamie -> Yeimi)', () => {
  const lyrics = buildLyricsWithChoruses('Yeimi', 'Yeimi');
  const variants = extractLyricNameVariants(lyrics, ['jamie']);
  assert.deepEqual(variants, { jamie: 'yeimi' });
});

test('extractLyricNameVariants: single-recipient sin respelling devuelve el mismo nombre', () => {
  const lyrics = buildLyricsWithChoruses('Frank', 'Frank');
  const variants = extractLyricNameVariants(lyrics, ['frank']);
  assert.deepEqual(variants, { frank: 'frank' });
});

test('extractLyricNameVariants: multi-destinatario empareja por primera letra', () => {
  const lyrics = buildLyricsWithChoruses('Christopher', 'Soraya');
  const variants = extractLyricNameVariants(lyrics, ['christopher', 'soraya']);
  assert.deepEqual(variants, { christopher: 'christopher', soraya: 'soraya' });
});

test('extractLyricNameVariants: sin letra o sin nombres devuelve objeto vacío', () => {
  assert.deepEqual(extractLyricNameVariants('', ['frank']), {});
  assert.deepEqual(extractLyricNameVariants('[Chorus 1]\nFrank, hola', []), {});
  assert.deepEqual(extractLyricNameVariants(null, null), {});
});

// Bug real (2026-07-13): "Un Ángel en Jenner" — la encuesta mencionaba el
// lugar real "Jenner" ("un lugar que se llama Jenner"), LanguageTool lo
// marcó como typo de "Tener" (no es nombre de destinatario, extractFirstNames
// no lo cubre) y el corrector automático lo reemplazó en la letra, rompiendo
// la fidelidad a la encuesta. extractSurveyProperNouns barre TODA la encuesta
// por palabras capitalizadas para que el gate de LanguageTool las excluya.
test('extractSurveyProperNouns: agarra un lugar mencionado fuera del campo de nombre (bug real "Jenner")', () => {
  const survey = "Special moments together: Cuando nos quedábamos en la orilla del mar en un lugar que se llama Jenner";
  const nouns = extractSurveyProperNouns(survey);
  assert.ok(nouns.includes('Jenner'));
});

test('extractSurveyProperNouns: filtra palabras capitalizadas comunes que arrancan oración', () => {
  const survey = "El nombre de mi hija es Soraya. Cuando ella nació, El Paso fue donde vivíamos.";
  const nouns = extractSurveyProperNouns(survey);
  assert.ok(nouns.includes('Soraya'));
  assert.ok(nouns.includes('Paso'));
  assert.ok(!nouns.includes('El'));
  assert.ok(!nouns.includes('Cuando'));
});

test('extractSurveyProperNouns: encuesta vacía o sin capitalizadas devuelve lista vacía', () => {
  assert.deepEqual(extractSurveyProperNouns(''), []);
  assert.deepEqual(extractSurveyProperNouns(null), []);
  assert.deepEqual(extractSurveyProperNouns('todo en minúscula sin nombres'), []);
});
