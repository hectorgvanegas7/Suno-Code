// watchdog.js — Supervisor externo para dejar cancioneterna-flow corriendo
// toda la noche sin nadie mirando.
//
// `node start-flow.js --loop` lo lanza SOLO (auto-arranque, ver start-flow.js
// — chequea logs/watchdog.pid para no duplicarlo; --no-watchdog lo
// desactiva). Corre en su propio proceso, detached — nunca comparte stdin
// con la terminal donde corre start-flow.js, así que no le importa si esa
// terminal está bloqueada esperando un ENTER que nadie va a dar.
//
// Cómo distingue "vivo" de "colgado" (rediseño auditoría 2026-07-09):
//   - start-flow.js late en CADA fase: los loops de poll/espera del Submit
//     escriben el heartbeat por tick, y runFlow entero corre bajo un ticker
//     por etapa (lib/heartbeat.js, createStageHeartbeat) con un TECHO por
//     etapa — si una etapa excede su techo, el ticker deja de latir a
//     propósito y este watchdog actúa. Antes el heartbeat solo latía en 2
//     loops y el watchdog mataba pipelines SANOS a mitad de Create/descarga.
//   - Antes de matar un PID, verifica que sea un proceso de Node — un PID
//     reciclado por Windows a otro programa se trata como "muerto", nunca se
//     le hace taskkill a un proceso ajeno.
//   - Tras relanzar, REFRESCA el heartbeat con el PID nuevo — sin esto, el
//     heartbeat viejo seguía en disco y cada tick siguiente relanzaba OTRO
//     pipeline (cascada de procesos duplicados, bug real).
//
// No mata ni relanza Chrome — Chrome lo lanza run.js/start-flow.js como
// proceso detached e independiente, y sigue vivo en el puerto 9333 aunque
// Node muera; --resume se reconecta a esa misma sesión.
//
// El resumen matutino NO necesita una Tarea Programada aparte: el loop
// continuo chequea la hora en cada tick y manda `sendDigest()` solo una vez
// por día, apenas pasa DIGEST_HOUR — y SOLO si el watchdog ya venía corriendo
// desde antes de esa hora (un watchdog arrancado a las 23:00 no manda el
// "resumen matutino" en su primer tick con datos de la tarde).
//
// Uso manual (rara vez hace falta, --loop ya lo auto-arranca):
//   node watchdog.js          → loop continuo, chequea cada 2 min (Ctrl+C para salir)
//   node watchdog.js --once   → un solo chequeo y sale (para probar)
//   node watchdog.js --digest → manda el resumen de las últimas 12h a mano y sale
//
// Circuit breaker: si reinicia MAX_RESTARTS_IN_WINDOW veces en
// RESTART_WINDOW_MS, deja de reintentar y avisa urgente — un bug real no se
// arregla reiniciando en loop toda la noche, y cada reinicio potencialmente
// re-gasta créditos de Suno/API desde donde --resume retome. El contador
// vive en watchdog-state.json Y en memoria: si el disco está lleno y el
// archivo no se puede escribir, el respaldo en memoria igual corta el loop.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { notify } = require('./lib/ntfy');
const { readHeartbeat, writeHeartbeat } = require('./lib/heartbeat');
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
const DISK_NOTIFY_COOLDOWN_MS = 60 * 60 * 1000; // aviso de disco máx. 1 vez/hora (antes spameaba cada 2 min)

// Respaldo en memoria del circuit breaker (ver comentario del header).
const memoryRestarts = [];
let lastDiskNotifyAt = 0;

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
    // best-effort — el respaldo en memoria (memoryRestarts) cubre este caso
  }
}

// Filtra timestamps ISO a los que caen dentro de windowMs desde `now` —
// pura, testeable sin tocar disco ni el reloj real.
function recentTimestamps(timestamps, now, windowMs) {
  return timestamps.filter((t) => now - new Date(t).getTime() < windowMs);
}

// Decisión pura de qué hacer con un heartbeat dado — extraída de checkOnce
// para poder testearla sin procesos ni disco (test/watchdog.test.js).
// Devuelve: 'no-heartbeat' | 'healthy' | 'circuit-breaker' | 'restart'.
// Un ts inválido (NaN) se trata como stale: un heartbeat corrupto no debe
// pasar por "sano" para siempre.
function decideAction({ heartbeat, nowMs, recentRestartCount, staleMs = STALE_THRESHOLD_MS, maxRestarts = MAX_RESTARTS_IN_WINDOW }) {
  if (!heartbeat) return 'no-heartbeat';
  const ageMs = nowMs - new Date(heartbeat.ts).getTime();
  if (Number.isFinite(ageMs) && ageMs < staleMs) return 'healthy';
  if (recentRestartCount >= maxRestarts) return 'circuit-breaker';
  return 'restart';
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ¿El PID corresponde a un proceso de Node? Windows recicla PIDs con ganas:
// un heartbeat/pidfile viejo puede apuntar a un PID que hoy es OTRO programa.
// Sin este chequeo, killPidTree podía hacer taskkill /T /F a un proceso ajeno,
// y isWatchdogRunning podía creer que "ya hay watchdog" mirando a un Chrome
// cualquiera (dejando la noche entera sin protección).
function looksLikeNodeProcess(pid) {
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf-8', timeout: 10000, windowsHide: true }).stdout || '';
      return /"node(\.exe)?"/i.test(out);
    }
    const out = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf-8', timeout: 10000 }).stdout || '';
    return /node/i.test(out);
  } catch {
    return false;
  }
}

function killPidTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

function relaunchPipeline() {
  const child = spawn('node', ['start-flow.js', '--loop', '--resume'], {
    cwd: __dirname,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

async function checkOnce() {
  const diskProblem = checkDiskSpace();
  if (diskProblem) {
    console.log(`[watchdog] ⚠️ ${diskProblem}`);
    if (Date.now() - lastDiskNotifyAt > DISK_NOTIFY_COOLDOWN_MS) {
      lastDiskNotifyAt = Date.now();
      await notify(`⚠️ ${diskProblem}`, { title: '💾 Watchdog: poco disco', priority: 'high', tags: 'floppy_disk' }).catch(() => {});
    }
  }

  const heartbeat = readHeartbeat();
  const now = Date.now();

  const wstate = readWatchdogState();
  const mergedRestarts = [...new Set([...(wstate.restarts || []), ...memoryRestarts])];
  const recentRestarts = recentTimestamps(mergedRestarts, now, RESTART_WINDOW_MS);

  const action = decideAction({ heartbeat, nowMs: now, recentRestartCount: recentRestarts.length });

  if (action === 'no-heartbeat') {
    console.log('[watchdog] Sin heartbeat todavía (el pipeline no arrancó, o recién arrancó) — no se toma acción.');
    return { action: 'none', reason: 'no-heartbeat' };
  }

  const ageMs = now - new Date(heartbeat.ts).getTime();
  if (action === 'healthy') {
    console.log(`[watchdog] OK — heartbeat de hace ${Math.round(ageMs / 1000)}s (modo: ${heartbeat.mode || '?'}${heartbeat.stage ? `, etapa: ${heartbeat.stage}` : ''}).`);
    return { action: 'none', reason: 'healthy' };
  }

  const pidAlive = isPidAlive(heartbeat.pid);
  const pidIsNode = pidAlive && looksLikeNodeProcess(heartbeat.pid);
  console.log(`[watchdog] ⚠️ Heartbeat viejo: ${Math.round(ageMs / 60000)} min (pid ${heartbeat.pid} ${pidAlive ? (pidIsNode ? 'vivo' : 'vivo pero NO es Node — PID reciclado, se trata como muerto') : 'muerto'}).`);

  if (action === 'circuit-breaker') {
    console.log(`[watchdog] 🛑 Circuit breaker: ya reinició ${recentRestarts.length} veces en los últimos ${RESTART_WINDOW_MS / 60000} min. NO reintenta más.`);
    logEvent({ event: 'circuit-breaker-tripped', recentRestarts: recentRestarts.length });
    await notify(
      `El pipeline quedó colgado y ya se reinició ${recentRestarts.length} veces en 30 min. Dejé de reintentar — necesita que lo mires vos.\nÚltima etapa conocida: ${heartbeat.stage || heartbeat.mode || '?'}.\nLog de eventos: logs/watchdog-events.jsonl`,
      { title: '🛑 Watchdog: circuit breaker — revisar YA', priority: 'urgent', tags: 'stop_sign' }
    ).catch(() => {});
    return { action: 'circuit-breaker', reason: 'too-many-restarts' };
  }

  if (pidIsNode) {
    console.log(`[watchdog] Matando el proceso colgado (pid ${heartbeat.pid})...`);
    killPidTree(heartbeat.pid);
  }

  const newPid = relaunchPipeline();
  const restartTs = new Date().toISOString();
  memoryRestarts.push(restartTs);
  wstate.restarts = [...recentRestarts, restartTs];
  writeWatchdogState(wstate);

  // Anti-cascada (bug real, auditoría 2026-07-09): refrescar el heartbeat con
  // el PID nuevo AHORA. El proceso relanzado tarda en llegar a su primer
  // latido propio; sin esto, el heartbeat viejo seguía en disco y cada tick
  // siguiente veía "stale + pid muerto" y relanzaba OTRO pipeline en paralelo.
  writeHeartbeat({ pid: newPid, mode: 'relaunched-by-watchdog' });

  logEvent({ event: 'restart', oldPid: heartbeat.pid, oldPidWasAlive: pidAlive, newPid, ageMinutes: Math.round(ageMs / 60000), lastStage: heartbeat.stage || heartbeat.mode || null });
  console.log(`[watchdog] ✅ Relanzado: node start-flow.js --loop --resume (nuevo pid ${newPid}).`);
  await notify(
    `El pipeline quedó colgado (heartbeat de ${Math.round(ageMs / 60000)} min, última etapa: ${heartbeat.stage || heartbeat.mode || '?'}) — lo reinicié solo con --resume.\nReinicios en los últimos 30 min: ${wstate.restarts.length} de ${MAX_RESTARTS_IN_WINDOW} antes del freno.`,
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
  const blockedSubmits = autoSubmitEvents.filter((e) => e.event === 'blocked-no-upload').length;

  const watchdogEvents = readJsonlEntries(WATCHDOG_EVENTS_PATH).filter(withinWindow);
  const restarts = watchdogEvents.filter((e) => e.event === 'restart').length;
  const circuitBreakerTripped = watchdogEvents.some((e) => e.event === 'circuit-breaker-tripped');

  const currentState = state.read();
  const diskProblem = checkDiskSpace();

  const allOk = failedSubmits === 0 && blockedSubmits === 0 && restarts === 0 && !circuitBreakerTripped && !diskProblem;
  const lines = [
    allOk && confirmedSubmits > 0 ? '✅ Noche limpia — nada requiere tu atención.' : null,
    `• Submits confirmados: ${confirmedSubmits}`,
    failedSubmits > 0 ? `• Submits FALLIDOS: ${failedSubmits} ⚠️ revisar en el Flow` : null,
    blockedSubmits > 0 ? `• Submits BLOQUEADOS (sin MP3 subido): ${blockedSubmits} 🛑 acción manual pendiente` : null,
    `• Reinicios del watchdog: ${restarts}${circuitBreakerTripped ? ' (🛑 circuit breaker se activó — revisar logs/watchdog-events.jsonl)' : ''}`,
    currentState?.titulo ? `• Última canción conocida: "${currentState.titulo}" (etapa: ${currentState.stage})` : null,
    diskProblem ? `• ⚠️ ${diskProblem}` : null,
  ].filter(Boolean).join('\n');

  console.log(lines);
  await notify(lines, {
    title: `🌙 Resumen de la noche (${lookbackHours}h) — Cancioneterna`,
    priority: allOk ? 'default' : 'high',
    tags: 'crescent_moon',
  }).catch(() => {});
}

// Resumen matutino sin depender de una Tarea Programada aparte: el watchdog
// ya está corriendo toda la noche, así que basta con que cada tick chequee
// si ya pasó DIGEST_HOUR y todavía no se mandó el de HOY (lastDigestDate en
// watchdog-state.json, formato YYYY-MM-DD del huso horario local).
function todayLocalDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Pura, testeable: ¿corresponde mandar el digest en este tick?
// Además de "ya pasó la hora y no se mandó hoy", exige que el watchdog venga
// corriendo desde ANTES de la hora del digest de HOY — un watchdog arrancado
// a las 23:00 (el caso normal: Hector lo deja al irse a dormir) NO debe
// mandar el "resumen matutino" en su primer tick con datos de la tarde
// (bug real, auditoría 2026-07-09).
function shouldSendDigest({ now, startedAt, lastDigestDate, digestHour = DIGEST_HOUR }) {
  if (now.getHours() < digestHour) return false;
  if (lastDigestDate === todayLocalDateStr(now)) return false;
  const todayCutoff = new Date(now);
  todayCutoff.setHours(digestHour, 0, 0, 0);
  if (new Date(startedAt).getTime() > todayCutoff.getTime()) return false;
  return true;
}

let watchdogStartedAt = null;

async function maybeSendDailyDigest() {
  const now = new Date();
  const wstate = readWatchdogState();
  if (!shouldSendDigest({ now, startedAt: watchdogStartedAt || now, lastDigestDate: wstate.lastDigestDate })) return;

  await sendDigest();
  wstate.lastDigestDate = todayLocalDateStr(now);
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
// mismo circuit breaker/reinicio. Exige que el PID además sea un proceso de
// Node (ver looksLikeNodeProcess — PID reciclado ≠ watchdog vivo).
function isWatchdogRunning() {
  try {
    const pid = parseInt(fs.readFileSync(WATCHDOG_PID_PATH, 'utf-8').trim(), 10);
    return Number.isFinite(pid) && isPidAlive(pid) && looksLikeNodeProcess(pid);
  } catch {
    return false;
  }
}

// Usado por start-flow.js al apagar --loop con Ctrl+C: matar el watchdog para
// que no "resucite" un pipeline apagado a propósito (bug real, auditoría
// 2026-07-09). Devuelve true si había uno vivo y se mató.
function stopWatchdogIfRunning() {
  try {
    const pid = parseInt(fs.readFileSync(WATCHDOG_PID_PATH, 'utf-8').trim(), 10);
    if (Number.isFinite(pid) && pid !== process.pid && isPidAlive(pid) && looksLikeNodeProcess(pid)) {
      try { process.kill(pid); } catch {}
      try { fs.unlinkSync(WATCHDOG_PID_PATH); } catch {}
      return true;
    }
  } catch {}
  return false;
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

  // Singleton: si ya hay OTRO watchdog vivo (pidfile con un Node ajeno),
  // salir en silencio — dos watchdogs duplican kills/relaunches. Cubre la
  // carrera de dos `--loop` lanzados casi a la vez (el chequeo de
  // start-flow.js no es atómico).
  if (isWatchdogRunning()) {
    console.log('[watchdog] Ya hay otro watchdog corriendo (logs/watchdog.pid) — este proceso sale.');
    return;
  }

  watchdogStartedAt = new Date().toISOString();
  writeWatchdogPid();
  process.on('exit', removeWatchdogPid);
  // Ctrl+C / kill "amable": el handler default de la señal NO dispara el
  // evento 'exit', así que el pidfile quedaba huérfano — salir explícito.
  process.on('SIGINT', () => { removeWatchdogPid(); process.exit(130); });
  process.on('SIGTERM', () => { removeWatchdogPid(); process.exit(143); });

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

if (require.main === module) {
  main().catch((err) => {
    console.error('watchdog.js falló:', err);
    process.exit(1);
  });
}

module.exports = {
  recentTimestamps,
  decideAction,
  shouldSendDigest,
  isPidAlive,
  looksLikeNodeProcess,
  checkOnce,
  sendDigest,
  isWatchdogRunning,
  stopWatchdogIfRunning,
  WATCHDOG_PID_PATH,
};
