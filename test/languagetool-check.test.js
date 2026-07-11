// test/languagetool-check.test.js — Suite de regresión local para
// lib/languagetool-check.js.
//
// 100% offline: nunca llama a la API real de LanguageTool — usa matches
// FAKE con el mismo shape verificado en vivo contra api.languagetool.org
// en esta sesión (rule.category.id, offset, length, message, replacements).
// Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCheckText,
  mapOffsetToLine,
  isExcludedMatch,
  filterMatches,
} = require('../lib/languagetool-check');

function fakeMatch({ categoryId, offset, length, message, replacements = [] }) {
  return {
    offset,
    length,
    message,
    replacements: replacements.map((value) => ({ value })),
    rule: { category: { id: categoryId } },
  };
}

test('buildCheckText: concatena las 6 secciones línea por línea y devuelve rangos correctos', () => {
  const sections = {
    'Verse 1': ['Primera línea', 'Segunda línea'],
    'Chorus 1': ['Tercera línea'],
    'Verse 2': [],
    'Chorus 2': [],
    'Bridge': [],
    'Outro': [],
  };
  const { text, lineRanges } = buildCheckText(sections);
  assert.equal(text, 'Primera línea\nSegunda línea\nTercera línea\n');
  assert.deepEqual(lineRanges, [
    { section: 'Verse 1', lineIndex: 0, start: 0, end: 13 },
    { section: 'Verse 1', lineIndex: 1, start: 14, end: 27 },
    { section: 'Chorus 1', lineIndex: 0, start: 28, end: 41 },
  ]);
});

test('mapOffsetToLine: ubica correctamente un offset dentro de la segunda línea, cruzando el límite de la primera', () => {
  const sections = { 'Verse 1': ['Aquella tarde tranquila', 'Recuerdo tu risa clara'], 'Chorus 1': [], 'Verse 2': [], 'Chorus 2': [], 'Bridge': [], 'Outro': [] };
  const { lineRanges } = buildCheckText(sections);
  // offset 30 cae dentro de "Recuerdo tu risa clara" (empieza en 25)
  const loc = mapOffsetToLine(30, lineRanges);
  assert.deepEqual(loc, { section: 'Verse 1', lineIndex: 1 });
});

test('mapOffsetToLine: offset dentro del separador "\\n" entre líneas devuelve null en vez de atribuir mal', () => {
  const sections = { 'Verse 1': ['Uno', 'Dos'], 'Chorus 1': [], 'Verse 2': [], 'Chorus 2': [], 'Bridge': [], 'Outro': [] };
  const { lineRanges } = buildCheckText(sections);
  // "Uno" ocupa offsets 0-3, el "\n" está en offset 3
  assert.equal(mapOffsetToLine(3, lineRanges), null);
});

test('isExcludedMatch: nombre respelleado foneticamente ("Maryuri") se excluye aunque LanguageTool lo marque', () => {
  assert.equal(isExcludedMatch('Maryuri', ['Maryuri', 'Aandrea']), true);
  assert.equal(isExcludedMatch('maryuri', ['Maryuri']), true, 'debe ser case-insensitive');
  assert.equal(isExcludedMatch('corazon', ['Maryuri', 'Aandrea']), false);
});

test('filterMatches: categorías TYPOS/CONFUSIONS/DIACRITICS cuentan como error duro, STYLE queda afuera', () => {
  const sections = { 'Verse 1': ['Hoy cumples otro ano de vida'], 'Chorus 1': [], 'Verse 2': [], 'Chorus 2': [], 'Bridge': [], 'Outro': [] };
  const { text, lineRanges } = buildCheckText(sections);
  const matches = [
    fakeMatch({ categoryId: 'CONFUSIONS', offset: 17, length: 3, message: '¿Quería decir «año»?', replacements: ['año'] }),
    fakeMatch({ categoryId: 'STYLE', offset: 0, length: 3, message: 'Sugerencia de estilo', replacements: ['Ese'] }),
  ];
  const issues = filterMatches(matches, text, lineRanges, []);
  assert.equal(issues.length, 1, `esperaba solo el fallo de CONFUSIONS, encontrados: ${JSON.stringify(issues)}`);
  assert.equal(issues[0].matchText, 'ano');
  assert.equal(issues[0].suggestion, 'año');
  assert.equal(issues[0].section, 'Verse 1');
  assert.equal(issues[0].lineIndex, 0);
  assert.equal(issues[0].kind, 'grammar_spelling');
});

test('filterMatches: match sobre un nombre excluido no se reporta aunque la categoría sea dura', () => {
  const sections = { 'Verse 1': ['Maryuri, hoy te canto con amor'], 'Chorus 1': [], 'Verse 2': [], 'Chorus 2': [], 'Bridge': [], 'Outro': [] };
  const { text, lineRanges } = buildCheckText(sections);
  const matches = [
    fakeMatch({ categoryId: 'TYPOS', offset: 0, length: 7, message: 'Posible error ortográfico', replacements: ['Mayoría'] }),
  ];
  const issues = filterMatches(matches, text, lineRanges, ['Maryuri']);
  assert.deepEqual(issues, []);
});

test('filterMatches: ambigüedad gramatical "esta"/"está" (DIACRITICS) se detecta — imposible con un diccionario simple', () => {
  const sections = { 'Verse 1': ['Mi corazon esta feliz hoy'], 'Chorus 1': [], 'Verse 2': [], 'Chorus 2': [], 'Bridge': [], 'Outro': [] };
  const { text, lineRanges } = buildCheckText(sections);
  const matches = [
    fakeMatch({ categoryId: 'DIACRITICS', offset: 11, length: 4, message: 'Si es del verbo estar, se escribe con tilde.', replacements: ['está'] }),
  ];
  const issues = filterMatches(matches, text, lineRanges, []);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].matchText, 'esta');
  assert.equal(issues[0].suggestion, 'está');
});
