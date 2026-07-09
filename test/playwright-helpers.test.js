// test/playwright-helpers.test.js — Suite de regresión local para la parte
// pura de lib/playwright-helpers.js (timeout de waitForEnterKey). El resto
// del archivo depende de Playwright/una página real y no se testea acá.
// 100% offline, sin red ni Chrome. Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForEnterKey, HumanTimeoutError, defaultHumanTimeoutMs } = require('../lib/playwright-helpers');

test('waitForEnterKey: sin timeoutMs, nunca rechaza por sí sola (queda esperando)', async () => {
  // No hay forma limpia de esperar "para siempre" en un test — solo confirma
  // que arrancó sin rechazar de inmediato y no deja timers colgados al
  // limpiar manualmente vía abortSignal (mismo mecanismo que usa el código real).
  const ac = new AbortController();
  const promise = waitForEnterKey(ac.signal, null);
  ac.abort();
  const result = await promise;
  assert.deepEqual(result, { timedOut: false });
});

test('waitForEnterKey: con timeoutMs, rechaza con HumanTimeoutError si nadie responde', async () => {
  await assert.rejects(
    () => waitForEnterKey(null, 30),
    (err) => {
      assert.ok(err instanceof HumanTimeoutError);
      assert.match(err.message, /min sin respuesta/);
      return true;
    }
  );
});

test('waitForEnterKey: abortSignal ya abortado resuelve de inmediato sin esperar', async () => {
  const ac = new AbortController();
  ac.abort();
  const result = await waitForEnterKey(ac.signal, 999999);
  assert.deepEqual(result, { timedOut: false });
});

test('defaultHumanTimeoutMs: sin la env var seteada, devuelve null (espera para siempre — comportamiento de siempre)', () => {
  const original = process.env.CANCIONETERNA_HUMAN_TIMEOUT_MS;
  delete process.env.CANCIONETERNA_HUMAN_TIMEOUT_MS;
  try {
    assert.equal(defaultHumanTimeoutMs(), null);
  } finally {
    if (original !== undefined) process.env.CANCIONETERNA_HUMAN_TIMEOUT_MS = original;
  }
});

test('defaultHumanTimeoutMs: con la env var seteada (--loop), devuelve el valor en ms', () => {
  const original = process.env.CANCIONETERNA_HUMAN_TIMEOUT_MS;
  process.env.CANCIONETERNA_HUMAN_TIMEOUT_MS = '1200000';
  try {
    assert.equal(defaultHumanTimeoutMs(), 1200000);
  } finally {
    if (original === undefined) delete process.env.CANCIONETERNA_HUMAN_TIMEOUT_MS;
    else process.env.CANCIONETERNA_HUMAN_TIMEOUT_MS = original;
  }
});

test('defaultHumanTimeoutMs: valor inválido en la env var se ignora (null, no crashea)', () => {
  const original = process.env.CANCIONETERNA_HUMAN_TIMEOUT_MS;
  process.env.CANCIONETERNA_HUMAN_TIMEOUT_MS = 'no-es-un-numero';
  try {
    assert.equal(defaultHumanTimeoutMs(), null);
  } finally {
    if (original === undefined) delete process.env.CANCIONETERNA_HUMAN_TIMEOUT_MS;
    else process.env.CANCIONETERNA_HUMAN_TIMEOUT_MS = original;
  }
});
