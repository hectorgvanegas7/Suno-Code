// Regresión del cruce silencioso de resultados A/B en los batches de Python.
// transcribe.py / clap_score.py / nisqa_score.py devuelven `file` con el path
// que recibieron; batchFileMismatch (lib/audio-analysis.js) verifica que el
// resultado i-ésimo corresponde al archivo pedido. Si Python reordenara u
// omitiera un resultado, sin este chequeo la recomendación de pickBestVersion
// podría salir de la versión equivocada.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { batchFileMismatch } = require('../lib/audio-analysis');

test('batchFileMismatch: mismo path exacto → sin problema', () => {
  assert.strictEqual(batchFileMismatch('C:\\audio\\a.mp3', 'C:\\audio\\a.mp3'), null);
});

test('batchFileMismatch: mismo archivo con separadores distintos → sin problema', () => {
  const expected = path.join('C:', 'audio', 'a.mp3');
  assert.strictEqual(batchFileMismatch(expected, 'C:/audio/a.mp3'), null);
});

test('batchFileMismatch: archivo distinto → reporta esperado y recibido', () => {
  const msg = batchFileMismatch('C:\\audio\\Version A.mp3', 'C:\\audio\\Version B.mp3');
  assert.ok(msg, 'debería reportar mismatch');
  assert.match(msg, /Version A\.mp3/);
  assert.match(msg, /Version B\.mp3/);
});

test('batchFileMismatch: sin dato para comparar → no puede verificar, no bloquea', () => {
  assert.strictEqual(batchFileMismatch(null, 'C:\\audio\\a.mp3'), null);
  assert.strictEqual(batchFileMismatch('C:\\audio\\a.mp3', null), null);
  assert.strictEqual(batchFileMismatch(undefined, undefined), null);
});
