// lib/pipeline-state.js — Estado compartido del pipeline entre scripts.
//
// Problema que resuelve: cada script (run.js, suno-fill.js, flow-submit.js,
// sheets.js) lee song.txt por su cuenta y asume que está trabajando sobre la
// canción correcta. Si run.js corre dos veces seguidas (cosa que pasa), o si
// una sesión de Suno quedó de una canción anterior, un script puede procesar
// la canción EQUIVOCADA en silencio. Eso es peligroso: una canción mal
// registrada o subida al Flow equivocado puede terminar en REDO por error del
// artista — y esos NO son elegibles para pago.
//
// Solución: run.js escribe state.json con el Song ID + título + etapa actual.
// Los scripts siguientes lo leen y validan "¿el Song ID que tengo en mano
// coincide con el del Flow / song.txt?" antes de hacer algo destructivo.
//
// Es deliberadamente simple: un solo JSON, lectura/escritura síncrona, sin
// dependencias. No es una base de datos; es una nota adhesiva entre procesos.

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'state.json');

// Etapas del pipeline, en orden.
const STAGES = {
  GENERATED: 'generated',      // run.js terminó, song.txt listo
  SUNO_FILLED: 'suno-filled',  // suno-fill.js llenó el formulario
  FLOW_FILLED: 'flow-filled',  // flow-submit.js llenó título/letra/notas
  COMPLETED: 'completed',      // --done: MP3 subido + registrado en la hoja
};

function read() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

// Escribe un patch sobre el estado existente (merge superficial). Siempre
// actualiza updatedAt.
function write(patch) {
  const current = read() || {};
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

// Inicia un estado nuevo y limpio para una canción recién generada. Borra
// cualquier rastro de la canción anterior.
function startNew({ songId, titulo, isRedo }) {
  const fresh = {
    songId,
    titulo,
    isRedo: !!isRedo,
    stage: STAGES.GENERATED,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(fresh, null, 2), 'utf-8');
  return fresh;
}

// Verifica que el Song ID que un script tiene en mano coincida con el del
// estado. Si no coinciden, devuelve un objeto con el problema descrito en vez
// de tirar (el script decide si abortar o sólo advertir). Sirve para atrapar
// "estoy por procesar una canción distinta a la que generé".
function checkSongId(songId) {
  const state = read();
  if (!state) {
    return { ok: false, reason: 'No existe state.json — ¿corriste run.js en esta sesión?' };
  }
  if (state.songId !== songId) {
    return {
      ok: false,
      reason: `Song ID no coincide. state.json tiene "${state.songId}" pero acá llegó "${songId}". ` +
        '¿Estás trabajando sobre la canción correcta?',
      expected: state.songId,
      got: songId,
    };
  }
  return { ok: true, state };
}

module.exports = { STAGES, STATE_PATH, read, write, startNew, checkSongId };
