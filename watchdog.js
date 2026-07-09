// watchdog.js — Supervisor externo para dejar cancioneterna-flow corriendo
// toda la noche sin nadie mirando.
//
// `node start-flow.js --loop` lo lanza SOLO (auto-arranque, ver start-flow.js
// — chequea logs/watchdog.pid para no duplicarlo; --no-watchdog lo
// desactiva). Corre en su propio proceso, detached — nunca comparte stdin
// con la terminal donde corre start-flow.js, así que no le importa si esa
// terminal está bloqueada esperando un ENTER que nadie va a dar. Ese caso
// puntual (pauseForHumanInteraction colgado para siempre) ya se cubre DESDE
// ADENTRO con el timeout de lib/playwright-helpers.js
// (CANCIONETERNA_HUMAN_TIMEOUT_MS, activado automático en --loop). Este
// watchdog cubre todo lo demás: el proceso Node murió del todo, o quedó
// colgado de verdad (heartbeat viejo con el PID todavía vivo — un hang que
// ni el timeout interno salvó).
//
// No mata ni relanza Chrome — Chrome lo lanza run.js/start-flow.js como
// proceso detached e independiente, y sigue vivo en el puerto 9333 aunque
// Node muera; --resume se reconecta a esa misma sesión.
//
// El resumen matutino NO necesita una Tarea Programada aparte: el loop
// continuo chequea la hora en cada tick y manda `sendDigest()` solo una vez
// por día, apenas pasa DIGEST_HOUR (default 7am) — ver maybeSendDailyDigest.
//
// Uso manual (rara vez hace falta, --loop ya lo auto-arranca):
//   node watchdog.js          → loop continuo, chequea cada 2 min (Ctrl+C para salir)
//   node watchdog.js --once   → un solo chequeo y sale (para probar)
//   node watchdog.js --digest → manda el resumen de las últimas 12h a mano y sale
//
// Circuit breaker: si reinicia MAX_RESTARTS_IN_WINDOW veces en
// RESTART_WINDOW_MS, deja de reintentar y avisa urgente — un bug real no se
// arregla reiniciando en loop toda la noche, y cada reinicio potencialmente
// re-gasta créditos de Suno/API desde donde --resume retome.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { notify } = require('./lib/ntfy');
const { readHeartbeat } = require('./lib/heartbeat');
const { checkDiskSpace } = require('./lib/preflight');
const state = require('./lib/pipeline-state');

const CHECK_INTERVAL_MS = 2 * 60 * 1000;
const STALE_THRESHOLD_MS = 5 * 60 * 1000;
const MAX_RESTARTS_IN_WINDOW = 3;
const RESTART_WINDOW_MS = 30 * 60 * 1000;
const LOGS_DIR = path.join(__dirname, 'logs');
const WATCHDOG_STATE_PATH = path.join(LOGS_DIR, 'watchdog-state.json');
const WATCHDOG_EVENTS_PATH = path.join(LOGS_DIR, 'watchdog-events.jsonl');
const AUTO_SUBMIT_EVENTS_PATH = path.join(LOGS_DIR, 'auto-submit-events.jsonl');
const WATCHDOG_PID_PATH = path.join(LOGS_DIR, 'watchdog.pid');
const DIGEST_HOUR = 7; // hora local a la que se manda el resumen matutino, sin Tarea Programada

function logEvent(event) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(WATCHDOG_EVENTS_PATH, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n', 'utf-8');
  } catch {
    // best-effort
  }
}

function readWatchdogState() {
  try {
    return JSON.parse(fs.readFileSync(WATCHDOG_STATE_PATH, 'utf-8'));
  } catch {
    return { restarts: [] };
  }
}

function writeWatchdogState(s) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const tmp = `${WATCHDOG_STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf-8');
    fs.renameSync(tmp, WATCHDOG_STATE_PATH);
  } catch {
    // best-effort
  }
}

// Filtra timestamps ISO a los que caen dentro de windowMs desde `now` —
// pura, testeable sin tocar disco ni el reloj real.
function recentTimestamps(timestamps, now, windowMs) {
  return timestamps.filter((t) => now - new Date(t).getTime() < windowMs);
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPidTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

function relaunchPipeline() {
  const child = spawn('node', ['start-flow.js', '--loop', '--resume'], {
    cwd: __dirname,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid;
}

async function checkOnce() {
  const diskProblem = checkDiskSpace();
  if (diskProblem) {
    console.log(`[watchdog] ⚠️ ${diskProblem}`);
    await notify(`⚠️ ${diskProblem}`, { title: 'Watchdog: disco', priority: 'high', tags: 'floppy_disk' }).catch(() => {});
  }

  const heartbeat = readHeartbeat();
  const now = Date.now();

  if (!heartbeat) {
    console.log('[watchdog] Sin heartbeat todavía (el pipeline no arrancó, o recién arrancó) — no se toma acción.');
    return { action: 'none', reason: 'no-heartbeat' };
  }

  const ageMs = now - new Date(heartbeat.ts).getTime();
  if (ageMs < STALE_THRESHOLD_MS) {
    console.log(`[watchdog] OK — heartbeat de hace ${Math.round(ageMs / 1000)}s (modo: ${heartbeat.mode || '?'}).`);
    return { action: 'none', reason: 'healthy' };
  }

  const pidAlive = isPidAlive(heartbeat.pid);
  console.log(`[watchdog] ⚠️ Heartbeat viejo: ${Math.round(ageMs / 60000)} min (pid ${heartbeat.pid} ${pidAlive ? 'vivo' : 'muerto'}).`);

  const wstate = readWatchdogState();
  const recentRestarts = recentTimestamps(wstate.restarts, now, RESTART_WINDOW_MS);
  if (recentRestarts.length >= MAX_RESTARTS_IN_WINDOW) {
    console.log(`[watchdog] 🛑 Circuit breaker: ya reinició ${recentRestarts.length} veces en los últimos ${RESTART_WINDOW_MS / 60000} min. NO reintenta más.`);
    logEvent({ event: 'circuit-breaker-tripped', recentRestarts: recentRestarts.length });
    await notify(
      `🛑 El pipeline quedó colgado y ya se reinició ${recentRestarts.length} veces en 30 min. Dejé de reintentar — necesita que lo mires vos.`,
      { title: '🛑 Watchdog: circuit breaker', priority: 'urgent', tags: 'stop_sign' }
    ).catch(() => {});
    return { action: 'circuit-breaker', reason: 'too-many-restarts' };
  }

  if (pidAlive) {
    console.log(`[watchdog] Matando el proceso colgado (pid ${heartbeat.pid})...`);
    killPidTree(heartbeat.pid);
  }

  const newPid = relaunchPipeline();
  wstate.restarts = [...recentRestarts, new Date().toISOString()];
  writeWatchdogState(wstate);
  logEvent({ event: 'restart', oldPid: heartbeat.pid, oldPidWasAlive: pidAlive, newPid, ageMinutes: Math.round(ageMs / 60000) });
  console.log(`[watchdog] ✅ Relanzado: node start-flow.js --loop --resume (nuevo pid ${newPid}).`);
  await notify(
    `🔄 El pipeline quedó colgado (heartbeat de ${Math.round(ageMs / 60000)} min) — lo reinicié solo (--resume). Reinicios en los últimos 30 min: ${wstate.restarts.length}.`,
    { title: '🔄 Watchdog: reinicio automático', priority: 'high', tags: 'arrows_counterclockwise' }
  ).catch(() => {});
  return { action: 'restarted', reason: 'stale-heartbeat' };
}

function readJsonlEntries(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function sendDigest({ lookbackHours = 12 } = {}) {
  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;
  const withinWindow = (e) => e.ts && new Date(e.ts).getTime() >= cutoff;

  const autoSubmitEvents = readJsonlEntries(AUTO_SUBMIT_EVENTS_PATH).filter(withinWindow);
  const confirmedSubmits = autoSubmitEvents.filter((e) => e.event === 'confirmed').length;
  const failedSubmits = autoSubmitEvents.filter((e) => e.event === 'failed').length;

  const watchdogEvents = readJsonlEntries(WATCHDOG_EVENTS_PATH).filter(withinWindow);
  const restarts = watchdogEvents.filter((e) => e.event === 'restart').length;
  const circuitBreakerTripped = watchdogEvents.some((e) => e.event === 'circuit-breaker-tripped');

  const currentState = state.read();
  const diskProblem = checkDiskSpace();

  const lines = [
    `🌙 Resumen de la noche (últimas ${lookbackHours}h):`,
    `• Auto-Submits confirmados: ${confirmedSubmits}`,
    failedSubmits > 0 ? `• Auto-Submits fallidos: ${failedSubmits} ⚠️` : null,
    `• Reinicios del watchdog: ${restarts}${circuitBreakerTripped ? ' (circuit breaker se activó ⚠️ revisar)' : ''}`,
    currentState?.titulo ? `• Última canción conocida: "${currentState.titulo}" (etapa: ${currentState.stage})` : null,
    diskProblem ? `• ⚠️ ${diskProblem}` : null,
  ].filter(Boolean).join('\n');

  console.log(lines);
  await notify(lines, { title: '🌙 Resumen nocturno — Cancionéterna', priority: 'default', tags: 'crescent_moon' }).catch(() => {});
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--digest')) {
    await sendDigest();
    return;
  }

  if (args.includes('--once')) {
    await checkOnce();
    return;
  }

  writeWatchdogPid();
  process.on('exit', removeWatchdogPid);

  console.log(`🐕 Watchdog iniciado (pid ${process.pid}) — chequea cada ${CHECK_INTERVAL_MS / 60000} min. Ctrl+C para salir.`);
  while (true) {
    try {
      await checkOnce();
    } catch (e) {
      console.error(`[watchdog] Error en el chequeo (no fatal): ${e.message}`);
    }
    await maybeSendDailyDigest();
    await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS));
  }
}

// Resumen matutino sin depender de una Tarea Programada aparte: el watchdog
// ya está corriendo toda la noche, así que basta con que cada tick chequee
// si ya pasó DIGEST_HOUR y todavía no se mandó el de HOY (lastDigestDate en
// watchdog-state.json, formato YYYY-MM-DD del huso horario local).
function todayLocalDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function maybeSendDailyDigest() {
  const now = new Date();
  if (now.getHours() < DIGEST_HOUR) return;

  const wstate = readWatchdogState();
  const today = todayLocalDateStr(now);
  if (wstate.lastDigestDate === today) return; // ya se mandó el de hoy

  await sendDigest();
  wstate.lastDigestDate = today;
  writeWatchdogState(wstate);
}

function writeWatchdogPid() {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(WATCHDOG_PID_PATH, String(process.pid), 'utf-8');
  } catch {
    // best-effort
  }
}

function removeWatchdogPid() {
  try {
    if (fs.readFileSync(WATCHDOG_PID_PATH, 'utf-8').trim() === String(process.pid)) {
      fs.unlinkSync(WATCHDOG_PID_PATH);
    }
  } catch {
    // best-effort — si ya no existe o es de otro pid, no tocar nada
  }
}

// Usado por start-flow.js (--loop) para saber si ya hay un watchdog vivo
// antes de lanzar uno nuevo — evita watchdogs duplicados peleándose por el
// mismo circuit breaker/reinicio.
function isWatchdogRunning() {
  try {
    const pid = parseInt(fs.readFileSync(WATCHDOG_PID_PATH, 'utf-8').trim(), 10);
    return Number.isFinite(pid) && isPidAlive(pid);
  } catch {
    return false;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('watchdog.js falló:', err);
    process.exit(1);
  });
}

module.exports = { recentTimestamps, isPidAlive, checkOnce, sendDigest, isWatchdogRunning, WATCHDOG_PID_PATH };
