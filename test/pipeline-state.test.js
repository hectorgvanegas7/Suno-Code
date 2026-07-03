// test/pipeline-state.test.js — Suite de regresión local para la parte pura
// de lib/pipeline-state.js (detección de song.txt pisado sin avisar).
//
// A propósito NO llama a read()/write()/startNew()/checkSongTxtContent():
// esas tocan el state.json REAL del pipeline (state.json de una canción en
// curso de Hector) — un test que las ejercite pisaría ese archivo. Solo se
// testea songTxtMatchesState(), que es pura (recibe el estado como parámetro,
// nunca lee/escribe disco). 100% offline. Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { songTxtMatchesState, hashContent } = require('../lib/pipeline-state');

test('songTxtMatchesState: sin state (null) no reporta problema', () => {
  assert.deepEqual(songTxtMatchesState('cualquier contenido', null), { ok: true });
});

test('songTxtMatchesState: state sin songTxtHash (estado viejo) no reporta problema', () => {
  assert.deepEqual(songTxtMatchesState('cualquier contenido', { songId: 'x' }), { ok: true });
});

test('songTxtMatchesState: contenido igual al hash guardado pasa', () => {
  const content = '**Título:** Test\n[Verse 1]\nlinea';
  const stateObj = { songTxtHash: hashContent(content) };
  assert.deepEqual(songTxtMatchesState(content, stateObj), { ok: true });
});

test('songTxtMatchesState: contenido distinto al hash guardado se detecta', () => {
  const original = '**Título:** Test\n[Verse 1]\nlinea original';
  const stateObj = { songTxtHash: hashContent(original) };
  const modified = '**Título:** Test\n[Verse 1]\nlinea pisada por otro proceso';
  const result = songTxtMatchesState(modified, stateObj);
  assert.equal(result.ok, false);
  assert.match(result.reason, /cambió desde que se generó/);
});
