// test/flow-helpers.test.js — Suite de regresión para shouldAutoSubmit
// (lib/flow-helpers.js), la única autoridad sobre si el Auto-Submit puede
// disparar. 100% offline — función pura. Corré con: npm test
//
// Contexto (auditoría de idempotencia 2026-07-14): un kill del watchdog entre
// el click de Submit y la escritura de COMPLETED dejaba la etapa en
// flow-filled, y el --resume re-subía y RE-SUBMITEABA (doble Submit a QA).
// El intent write-ahead de submit (lib/pipeline-state.js) + este gate cierran
// ese agujero.

const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldAutoSubmit } = require('../lib/flow-helpers');

const OK_BASE = {
  elapsedMin: 28,
  autoSubmitMinutes: 27,
  uploadConfirmed: true,
  submitIntent: null,
  songId: 'PS0180',
};

test('shouldAutoSubmit: todo verde → go', () => {
  assert.deepEqual(shouldAutoSubmit(OK_BASE), { go: true });
});

test('shouldAutoSubmit: intent de submit ya clickeado para ESTA canción → bloqueado (doble Submit)', () => {
  const r = shouldAutoSubmit({
    ...OK_BASE,
    submitIntent: { songId: 'PS0180', clickedAt: '2026-07-14T03:00:00Z' },
  });
  assert.equal(r.go, false);
  assert.equal(r.reason, 'submit-already-clicked');
});

test('shouldAutoSubmit: el gate de doble Submit gana incluso con upload confirmado y timer vencido', () => {
  const r = shouldAutoSubmit({
    elapsedMin: 120,
    autoSubmitMinutes: 27,
    uploadConfirmed: true,
    submitIntent: { songId: 'PS0180', clickedAt: 't', confirmedAt: 't2' },
    songId: 'PS0180',
  });
  assert.equal(r.reason, 'submit-already-clicked');
});

test('shouldAutoSubmit: intent de submit de OTRA canción no bloquea', () => {
  const r = shouldAutoSubmit({
    ...OK_BASE,
    submitIntent: { songId: 'PS0999', clickedAt: 't' },
  });
  assert.deepEqual(r, { go: true });
});

test('shouldAutoSubmit: sin upload confirmado → bloqueado (gate de la auditoría 2026-07-09)', () => {
  const r = shouldAutoSubmit({ ...OK_BASE, uploadConfirmed: false });
  assert.equal(r.go, false);
  assert.equal(r.reason, 'no-upload');
});

test('shouldAutoSubmit: sin upload Y con submit previo → el submit previo gana (es el más peligroso)', () => {
  const r = shouldAutoSubmit({
    ...OK_BASE,
    uploadConfirmed: false,
    submitIntent: { songId: 'PS0180', clickedAt: 't' },
  });
  assert.equal(r.reason, 'submit-already-clicked');
});

test('shouldAutoSubmit: timer sin llegar → too-early', () => {
  const r = shouldAutoSubmit({ ...OK_BASE, elapsedMin: 20 });
  assert.equal(r.go, false);
  assert.equal(r.reason, 'too-early');
});

test('shouldAutoSubmit: elapsedMin NaN/undefined nunca dispara (comparación falla cerrada)', () => {
  assert.equal(shouldAutoSubmit({ ...OK_BASE, elapsedMin: NaN }).go, false);
  assert.equal(shouldAutoSubmit({ ...OK_BASE, elapsedMin: undefined }).go, false);
});
