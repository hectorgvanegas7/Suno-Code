// test/session-time.test.js — Suite de regresión local para lib/session-time.js.
//
// 100% offline. Cubre el bug real encontrado en auditoría (2026-07-03): una
// sesión de horas exactas ("1h session", sin minutos) nunca llegaba a esta
// función porque el selector de DOM en start-flow.js exigía la palabra "min"
// — el fix real está en el selector (readRecentCompletion), pero esta suite
// fija el contrato de parseSessionTime en sí para que no vuelva a romperse.
// Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSessionTime, parseWebpageTimer } = require('../lib/session-time');

test('parseSessionTime: "26 min session" (solo minutos)', () => {
  assert.deepEqual(parseSessionTime('26 min session'), { timeHHMM: '00:26', totalTimeDecimal: 0.43 });
});

test('parseSessionTime: "1h 5min session" (horas + minutos)', () => {
  assert.deepEqual(parseSessionTime('1h 5min session'), { timeHHMM: '01:05', totalTimeDecimal: 1.08 });
});

test('parseSessionTime: "1h session" (horas exactas, sin minutos)', () => {
  assert.deepEqual(parseSessionTime('1h session'), { timeHHMM: '01:00', totalTimeDecimal: 1 });
});

test('parseSessionTime: "2 hours session" (variante en inglés completo)', () => {
  assert.deepEqual(parseSessionTime('2 hours session'), { timeHHMM: '02:00', totalTimeDecimal: 2 });
});

test('parseSessionTime: "65 min session" (más de una hora en minutos)', () => {
  assert.deepEqual(parseSessionTime('65 min session'), { timeHHMM: '01:05', totalTimeDecimal: 1.08 });
});

test('parseSessionTime: texto sin formato reconocible devuelve null', () => {
  assert.equal(parseSessionTime('sin duración'), null);
});

test('parseSessionTime: texto vacío/null/undefined devuelve null', () => {
  assert.equal(parseSessionTime(''), null);
  assert.equal(parseSessionTime(null), null);
  assert.equal(parseSessionTime(undefined), null);
});

test('parseWebpageTimer: MM:SS con punto medio', () => {
  assert.equal(parseWebpageTimer('32:21 · 20 min target'), 32.35);
});

test('parseWebpageTimer: MM:SS con guión', () => {
  assert.equal(parseWebpageTimer('05:12 - 20 min target'), 5.2);
});

test('parseWebpageTimer: HH:MM:SS con punto medio', () => {
  assert.equal(parseWebpageTimer('1:12:30 · 20 min target'), 72.5);
});

test('parseWebpageTimer: texto inválido devuelve null', () => {
  assert.equal(parseWebpageTimer('32:21 sin target'), null);
  assert.equal(parseWebpageTimer(''), null);
  assert.equal(parseWebpageTimer(null), null);
});
