// lib/heartbeat.js — "sigo vivo" del proceso, independiente de state.json.
//
// state.json solo cambia cuando avanza una canción — si la cola está vacía y
// start-flow.js está sanamente en --poll esperando, pueden pasar horas sin
// que se toque. Un watchdog que solo mirara state.json reiniciaría un
// proceso perfectamente sano. Este archivo lo escriben:
//   1. Los loops de polling (runPoll) y de espera del Submit (runFlow) en
//      cada tick.
//   2. El ticker por etapa (createStageHeartbeat) DURANTE todo runFlow —
//      sin él, las fases largas (run.js, Create+descarga de hasta 8 min,
//      demucs/Whisper) pasaban >5 min sin latir y el watchdog mataba un
//      pipeline SANO a mitad de canción (bug real, auditoría 2026-07-09).
//
// Deliberadamente best-effort: nunca lanza, nunca bloquea el pipeline.

const fs = require('fs');
const path = require('path');

const HEARTBEAT_PATH = path.join(__dirname, '..', 'logs', 'heartbeat.json');

function writeHeartbeat(extra = {}, { heartbeatPath = HEARTBEAT_PATH } = {}) {
  try {
    fs.mkdirSync(path.dirname(heartbeatPath), { recursive: true });
    const tmpPath = `${heartbeatPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...extra }, null, 2), 'utf-8');
    fs.renameSync(tmpPath, heartbeatPath);
  } catch {
    // best-effort
  }
}

function readHeartbeat({ heartbeatPath = HEARTBEAT_PATH } = {}) {
  try {
    return JSON.parse(fs.readFileSync(heartbeatPath, 'utf-8'));
  } catch {
    return null;
  }
}

// Borra el heartbeat — se usa al apagar --loop a propósito (Ctrl+C): un
// heartbeat viejo tirado en disco hace que el watchdog "resucite" un pipeline
// que Hector apagó adrede, o que dispare un relanzamiento espurio al próximo
// arranque (el archivo nunca envejece solo).
function clearHeartbeat({ heartbeatPath = HEARTBEAT_PATH } = {}) {
  try { fs.unlinkSync(heartbeatPath); } catch {}
}

// Ticker de heartbeat por ETAPA para runFlow: mantiene el heartbeat latiendo
// mientras una fase larga y legítima corre (generación LLM, Create+descarga,
// pausas humanas con timeout, demucs) — pero SOLO hasta el techo de la etapa
// (maxMinutes). Si la etapa excede su techo, el ticker deja de latir A
// PROPÓSITO: el heartbeat envejece, y el watchdog externo (>5 min viejo) mata
// y relanza. Así "vivo y avanzando" y "colgado de verdad" siguen siendo
// distinguibles sin que el watchdog tenga que conocer las etapas.
//
// Regla de convivencia de tiempos (auditoría 2026-07-09): el techo de
// cualquier etapa que pueda contener una pausa humana debe ser MAYOR que
// CANCIONETERNA_HUMAN_TIMEOUT_MS (20 min default) — si no, el watchdog mata
// antes de que el timeout humano llegue a actuar y ese mecanismo queda muerto.
function createStageHeartbeat({ intervalMs = 30 * 1000, heartbeatPath = HEARTBEAT_PATH, extra = {} } = {}) {
  let stage = 'inicio';
  let stageStartedAt = Date.now();
  let maxMs = 30 * 60 * 1000;

  // Devuelve true si latió, false si la etapa ya excedió su techo (y por lo
  // tanto se deja envejecer el heartbeat a propósito). Expuesto para tests.
  const tick = () => {
    if (Date.now() - stageStartedAt >= maxMs) return false;
    writeHeartbeat({
      mode: 'stage',
      stage,
      stageStartedAt: new Date(stageStartedAt).toISOString(),
      stageMaxMinutes: Math.round(maxMs / 60000),
      ...extra,
    }, { heartbeatPath });
    return true;
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    setStage(newStage, { maxMinutes = 30 } = {}) {
      stage = newStage;
      stageStartedAt = Date.now();
      maxMs = maxMinutes * 60 * 1000;
      tick();
    },
    tick,
    stop() { clearInterval(timer); },
  };
}

module.exports = { writeHeartbeat, readHeartbeat, clearHeartbeat, createStageHeartbeat, HEARTBEAT_PATH };
