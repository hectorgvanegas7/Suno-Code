// lib/heartbeat.js — "sigo vivo" del proceso, independiente de state.json.
//
// state.json solo cambia cuando avanza una canción — si la cola está vacía y
// start-flow.js está sanamente en --poll esperando, pueden pasar horas sin
// que se toque. Un watchdog que solo mirara state.json reiniciaría un
// proceso perfectamente sano. Este archivo lo escriben los loops de polling
// (runPoll) y de espera del Submit (runFlow) en cada tick — el watchdog
// externo (watchdog.js) lo usa para distinguir "vivo pero sin nada que
// hacer" de "realmente colgado".
//
// Deliberadamente best-effort: nunca lanza, nunca bloquea el pipeline.

const fs = require('fs');
const path = require('path');

const HEARTBEAT_PATH = path.join(__dirname, '..', 'logs', 'heartbeat.json');

function writeHeartbeat(extra = {}) {
  try {
    fs.mkdirSync(path.dirname(HEARTBEAT_PATH), { recursive: true });
    const tmpPath = `${HEARTBEAT_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...extra }, null, 2), 'utf-8');
    fs.renameSync(tmpPath, HEARTBEAT_PATH);
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

module.exports = { writeHeartbeat, readHeartbeat, HEARTBEAT_PATH };
