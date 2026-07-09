// test/watchdog.test.js — Suite de regresión local para la lógica pura de
// watchdog.js (recentTimestamps, isPidAlive). checkOnce/sendDigest tocan
// disco/red/procesos reales y no se testean acá (mismo criterio que
// verify-audio.js/qa-dashboard.js — scripts de entrada, no lib/).
// 100% offline. Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { recentTimestamps, isPidAlive, isWatchdogRunning, WATCHDOG_PID_PATH } = require('../watchdog');

test('recentTimestamps: filtra solo los timestamps dentro de la ventana', () => {
  const now = Date.now();
  const timestamps = [
    new Date(now - 5 * 60 * 1000).toISOString(),  // hace 5 min — dentro de 30 min
    new Date(now - 20 * 60 * 1000).toISOString(), // hace 20 min — dentro de 30 min
    new Date(now - 45 * 60 * 1000).toISOString(), // hace 45 min — fuera de 30 min
  ];
  const result = recentTimestamps(timestamps, now, 30 * 60 * 1000);
  assert.equal(result.length, 2);
});

test('recentTimestamps: lista vacía devuelve lista vacía', () => {
  assert.deepEqual(recentTimestamps([], Date.now(), 30 * 60 * 1000), []);
});

test('recentTimestamps: circuit breaker — 3 reinicios en la ventana alcanzan el máximo', () => {
  const now = Date.now();
  const timestamps = [
    new Date(now - 1 * 60 * 1000).toISOString(),
    new Date(now - 10 * 60 * 1000).toISOString(),
    new Date(now - 25 * 60 * 1000).toISOString(),
  ];
  const result = recentTimestamps(timestamps, now, 30 * 60 * 1000);
  assert.equal(result.length, 3);
});

test('isPidAlive: el propio proceso del test está vivo', () => {
  assert.equal(isPidAlive(process.pid), true);
});

test('isPidAlive: un PID que casi seguro no existe devuelve false', () => {
  assert.equal(isPidAlive(999999999), false);
});

test('isWatchdogRunning: false si logs/watchdog.pid apunta a un PID muerto', () => {
  fs.mkdirSync(require('path').dirname(WATCHDOG_PID_PATH), { recursive: true });
  const original = fs.existsSync(WATCHDOG_PID_PATH) ? fs.readFileSync(WATCHDOG_PID_PATH, 'utf-8') : null;
  try {
    fs.writeFileSync(WATCHDOG_PID_PATH, '999999999', 'utf-8');
    assert.equal(isWatchdogRunning(), false);
  } finally {
    if (original === null) fs.rmSync(WATCHDOG_PID_PATH, { force: true });
    else fs.writeFileSync(WATCHDOG_PID_PATH, original, 'utf-8');
  }
});

test('isWatchdogRunning: true si logs/watchdog.pid apunta a un PID vivo', () => {
  fs.mkdirSync(require('path').dirname(WATCHDOG_PID_PATH), { recursive: true });
  const original = fs.existsSync(WATCHDOG_PID_PATH) ? fs.readFileSync(WATCHDOG_PID_PATH, 'utf-8') : null;
  try {
    fs.writeFileSync(WATCHDOG_PID_PATH, String(process.pid), 'utf-8');
    assert.equal(isWatchdogRunning(), true);
  } finally {
    if (original === null) fs.rmSync(WATCHDOG_PID_PATH, { force: true });
    else fs.writeFileSync(WATCHDOG_PID_PATH, original, 'utf-8');
  }
});

test('isWatchdogRunning: false si no existe logs/watchdog.pid', () => {
  const original = fs.existsSync(WATCHDOG_PID_PATH) ? fs.readFileSync(WATCHDOG_PID_PATH, 'utf-8') : null;
  try {
    fs.rmSync(WATCHDOG_PID_PATH, { force: true });
    assert.equal(isWatchdogRunning(), false);
  } finally {
    if (original !== null) fs.writeFileSync(WATCHDOG_PID_PATH, original, 'utf-8');
  }
});
