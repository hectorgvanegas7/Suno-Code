// test/song-corrector.test.js — Suite de regresión local para la parte pura
// de lib/song-corrector.js (buildPatchSchema). patchSongLines() en sí llama
// a la API de Anthropic y no se testea acá (100% offline, sin red).
// Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPatchSchema, LYRICS_SECTION_KEYS } = require('../lib/song-corrector');

test('buildPatchSchema: incluye las 6 secciones de letra como propiedades requeridas', () => {
  const schema = buildPatchSchema();
  assert.deepEqual(schema.properties.letras.required, LYRICS_SECTION_KEYS);
  assert.deepEqual(Object.keys(schema.properties.letras.properties), LYRICS_SECTION_KEYS);
});

test('buildPatchSchema: cada sección es un array de strings', () => {
  const schema = buildPatchSchema();
  for (const sec of LYRICS_SECTION_KEYS) {
    assert.deepEqual(schema.properties.letras.properties[sec], { type: 'array', items: { type: 'string' } });
  }
});

test('buildPatchSchema: no permite propiedades fuera de "letras" (additionalProperties: false)', () => {
  const schema = buildPatchSchema();
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.letras.additionalProperties, false);
  assert.deepEqual(schema.required, ['letras']);
});
