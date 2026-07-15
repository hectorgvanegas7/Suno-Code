// test/watchdog.test.js — Suite de regresión local para la lógica pura de
// watchdog.js: recentTimestamps, isPidAlive, decideAction (la decisión de
// matar/relanzar/frenar, extraída de checkOnce para poder testearla — antes
// checkOnce no tenía NINGÚN test) y shouldSendDigest (el gating del resumen
// matutino). checkOnce/sendDigest completos tocan disco/red/procesos reales
// y no se testean acá. 100% offline. Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { recentTimestamps, isPidAlive, isWatchdogRunning, decideAction, shouldSendDigest, looksLikeNodeProcess, WATCHDOG_PID_PATH } = require('../watchdog');

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

// ─── decideAction: la decisión matar/relanzar/frenar, ahora testeable ────────

const STALE = 5 * 60 * 1000;

test('decideAction: sin heartbeat → no-heartbeat (nunca actúa a ciegas)', () => {
  assert.equal(decideAction({ heartbeat: null, nowMs: Date.now(), recentRestartCount: 0 }), 'no-heartbeat');
});

test('decideAction: heartbeat fresco → healthy, sin importar cuántos reinicios recientes haya', () => {
  const now = Date.now();
  const heartbeat = { ts: new Date(now - 60 * 1000).toISOString(), pid: 1234 };
  assert.equal(decideAction({ heartbeat, nowMs: now, recentRestartCount: 0 }), 'healthy');
  assert.equal(decideAction({ heartbeat, nowMs: now, recentRestartCount: 99 }), 'healthy');
});

test('decideAction: heartbeat viejo con pocos reinicios → restart', () => {
  const now = Date.now();
  const heartbeat = { ts: new Date(now - STALE - 60 * 1000).toISOString(), pid: 1234 };
  assert.equal(decideAction({ heartbeat, nowMs: now, recentRestartCount: 0 }), 'restart');
  assert.equal(decideAction({ heartbeat, nowMs: now, recentRestartCount: 2 }), 'restart');
});

test('decideAction: heartbeat viejo con 3+ reinicios recientes → circuit-breaker (nunca crash-loopea toda la noche)', () => {
  const now = Date.now();
  const heartbeat = { ts: new Date(now - STALE - 60 * 1000).toISOString(), pid: 1234 };
  assert.equal(decideAction({ heartbeat, nowMs: now, recentRestartCount: 3 }), 'circuit-breaker');
});

test('decideAction: heartbeat con ts corrupto (NaN) se trata como viejo, no como sano para siempre', () => {
  const heartbeat = { ts: 'no-es-una-fecha', pid: 1234 };
  assert.equal(decideAction({ heartbeat, nowMs: Date.now(), recentRestartCount: 0 }), 'restart');
});

// ─── shouldSendDigest: el resumen matutino, sin el bug de las 23:00 ──────────

function at(dateStr) { return new Date(dateStr); }

test('shouldSendDigest: watchdog corriendo desde anoche + pasa las 7am + no se mandó hoy → true', () => {
  assert.equal(shouldSendDigest({
    now: at('2026-07-09T07:02:00'),
    startedAt: at('2026-07-08T23:00:00').toISOString(),
    lastDigestDate: '2026-07-08',
  }), true);
});

test('shouldSendDigest: watchdog recién arrancado a las 23:00 NO manda el "resumen matutino" en su primer tick (bug real 2026-07-09)', () => {
  assert.equal(shouldSendDigest({
    now: at('2026-07-09T23:02:00'),
    startedAt: at('2026-07-09T23:00:00').toISOString(),
    lastDigestDate: null,
  }), false);
});

test('shouldSendDigest: antes de la hora del digest → false', () => {
  assert.equal(shouldSendDigest({
    now: at('2026-07-09T05:30:00'),
    startedAt: at('2026-07-08T22:00:00').toISOString(),
    lastDigestDate: null,
  }), false);
});

test('shouldSendDigest: ya se mandó el de hoy → false (una sola vez por día)', () => {
  assert.equal(shouldSendDigest({
    now: at('2026-07-09T09:00:00'),
    startedAt: at('2026-07-08T22:00:00').toISOString(),
    lastDigestDate: '2026-07-09',
  }), false);
});

test('shouldSendDigest: watchdog arrancado a las 10am de hoy no manda el de hoy (arrancó después del corte de las 7)', () => {
  assert.equal(shouldSendDigest({
    now: at('2026-07-09T10:05:00'),
    startedAt: at('2026-07-09T10:00:00').toISOString(),
    lastDigestDate: null,
  }), false);
});

// ─── looksLikeNodeProcess: validación anti PID reciclado ─────────────────────

test('looksLikeNodeProcess: el propio proceso del test (Node) es reconocido como Node', () => {
  assert.equal(looksLikeNodeProcess(process.pid), true);
});

test('looksLikeNodeProcess: un PID inexistente devuelve false', () => {
  assert.equal(looksLikeNodeProcess(999999999), false);
});

// ─── parseFactVerdict: veredictos de calibración FP/TP (2026-07-14) ───────────

const { parseFactVerdict } = require('../watchdog');

test('parseFactVerdict: parsea fact:<songId>:<tp|fp> (songId con guiones/UUID)', () => {
  assert.deepEqual(parseFactVerdict('fact:PS0180:tp'), { songId: 'PS0180', verdict: 'tp' });
  assert.deepEqual(parseFactVerdict('fact:333d963b-1601-4281-bf87-ad626964a482:fp'), { songId: '333d963b-1601-4281-bf87-ad626964a482', verdict: 'fp' });
});

test('parseFactVerdict: ignora respuestas de pausa y basura (no colisiona con el formato <requestId>:<ok|abort>)', () => {
  assert.equal(parseFactVerdict('a1b2c3d4:ok'), null);
  assert.equal(parseFactVerdict('fact:PS0180:yes'), null);
  assert.equal(parseFactVerdict('hola'), null);
  assert.equal(parseFactVerdict(''), null);
  assert.equal(parseFactVerdict(null), null);
});

// ─── shouldRunDriftCheck: drift check diario solo con pipeline ocioso ─────────

const { shouldRunDriftCheck } = require('../watchdog');

test('shouldRunDriftCheck: pasada la hora, sin corrida hoy y pipeline ocioso → true', () => {
  const now = new Date('2026-07-14T08:30:00');
  assert.equal(shouldRunDriftCheck({ now, lastDriftDate: '2026-07-13', stateObj: { stage: 'completed' } }), true);
  assert.equal(shouldRunDriftCheck({ now, lastDriftDate: null, stateObj: null }), true);
});

test('shouldRunDriftCheck: JAMÁS con una canción en vuelo (goto podría pisar el formulario de Suno)', () => {
  const now = new Date('2026-07-14T08:30:00');
  for (const stage of ['generated', 'suno-filled', 'flow-filled']) {
    assert.equal(shouldRunDriftCheck({ now, lastDriftDate: null, stateObj: { stage } }), false, `stage=${stage} debería bloquear el drift check`);
  }
});

test('shouldRunDriftCheck: una sola vez por día y nunca antes de la hora', () => {
  assert.equal(shouldRunDriftCheck({ now: new Date('2026-07-14T08:30:00'), lastDriftDate: '2026-07-14', stateObj: null }), false);
  assert.equal(shouldRunDriftCheck({ now: new Date('2026-07-14T03:00:00'), lastDriftDate: null, stateObj: null }), false);
});
