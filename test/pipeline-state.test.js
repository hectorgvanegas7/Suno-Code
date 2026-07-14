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
const { songTxtMatchesState, hashContent, interpretResume, STAGES } = require('../lib/pipeline-state');

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

// ─── interpretResume: intents write-ahead (auditoría de idempotencia 2026-07-14)
// Pura (recibe el estado como parámetro) — igual que songTxtMatchesState, nunca
// toca el state.json real.

const BASE = { songId: 'PS0180', titulo: 'Test', stage: STAGES.SUNO_FILLED };

test('interpretResume: sin state es resume-safe', () => {
  assert.equal(interpretResume(null), 'resume-safe');
});

test('interpretResume: sin intents es resume-safe', () => {
  assert.equal(interpretResume({ ...BASE }), 'resume-safe');
});

test('interpretResume: create clickeado SIN descarga → create-clicked-no-download (jamás re-Create)', () => {
  const st = { ...BASE, intents: { create: { songId: 'PS0180', clickedAt: '2026-07-14T03:00:00Z' } } };
  assert.equal(interpretResume(st), 'create-clicked-no-download');
});

test('interpretResume: create clickeado CON descarga confirmada → resume-safe', () => {
  const st = { ...BASE, intents: { create: { songId: 'PS0180', clickedAt: 't1', downloadedAt: 't2' } } };
  assert.equal(interpretResume(st), 'resume-safe');
});

test('interpretResume: intent de create de OTRA canción se ignora', () => {
  const st = { ...BASE, intents: { create: { songId: 'PS0999', clickedAt: 't1' } } };
  assert.equal(interpretResume(st), 'resume-safe');
});

test('interpretResume: submit clickeado sin confirmación → submit-pending-verify (jamás re-submit ciego)', () => {
  const st = { ...BASE, stage: STAGES.FLOW_FILLED, intents: { submit: { songId: 'PS0180', clickedAt: 't1' } } };
  assert.equal(interpretResume(st), 'submit-pending-verify');
});

test('interpretResume: submit confirmado (modal) sin cierre → run-done-only', () => {
  const st = { ...BASE, stage: STAGES.FLOW_FILLED, intents: { submit: { songId: 'PS0180', clickedAt: 't1', confirmedAt: 't2' } } };
  assert.equal(interpretResume(st), 'run-done-only');
});

test('interpretResume: submit clickeado pero etapa ya COMPLETED → resume-safe (cierre ya registrado)', () => {
  const st = { ...BASE, stage: STAGES.COMPLETED, intents: { submit: { songId: 'PS0180', clickedAt: 't1', confirmedAt: 't2' } } };
  assert.equal(interpretResume(st), 'resume-safe');
});

test('interpretResume: intent de submit de OTRA canción se ignora', () => {
  const st = { ...BASE, stage: STAGES.FLOW_FILLED, intents: { submit: { songId: 'PS0999', clickedAt: 't1' } } };
  assert.equal(interpretResume(st), 'resume-safe');
});

test('interpretResume: el submit pendiente tiene prioridad sobre el create pendiente', () => {
  const st = {
    ...BASE,
    stage: STAGES.FLOW_FILLED,
    intents: {
      create: { songId: 'PS0180', clickedAt: 't0' },
      submit: { songId: 'PS0180', clickedAt: 't1' },
    },
  };
  assert.equal(interpretResume(st), 'submit-pending-verify');
});
