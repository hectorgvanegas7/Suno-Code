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
const crypto = require('crypto');

const STATE_PATH = path.join(__dirname, '..', 'state.json');
const SONG_PATH_FOR_HASH = path.join(__dirname, '..', 'song.txt');

function hashContent(content) {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 16);
}

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

// Escritura atómica: tmp + rename. Un crash a mitad de un writeFileSync directo
// dejaba state.json truncado, y read() devuelve null ante JSON inválido — con lo
// cual las protecciones aguas abajo (salvaguarda anti-Create-duplicado en
// start-flow.js, auto-detección del Submit) se apagaban en silencio.
function atomicWriteJson(filePath, obj) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

// Escribe un patch sobre el estado existente (merge superficial). Siempre
// actualiza updatedAt.
function write(patch) {
  const current = read() || {};
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  atomicWriteJson(STATE_PATH, next);
  return next;
}

// Inicia un estado nuevo y limpio para una canción recién generada. Borra
// cualquier rastro de la canción anterior.
function startNew({ songId, titulo, isRedo }) {
  // Hash de song.txt en el momento exacto en que se generó — permite que los
  // scripts siguientes (suno-fill.js, flow-submit.js) detecten si el archivo
  // cambió de forma inesperada entre medio (ej. un `run.js --dry-run` suelto
  // pisando la letra real de una canción en curso, bug real visto en la
  // práctica — ver IDEAS.md). Es solo informativo: Gabo puede editar song.txt
  // a mano a propósito (paso 2 manual del flujo), así que un mismatch se
  // reporta como advertencia, nunca como abort automático.
  let songTxtHash = null;
  try {
    songTxtHash = hashContent(fs.readFileSync(SONG_PATH_FOR_HASH, 'utf-8'));
  } catch {
    // song.txt no existe todavía en el momento de startNew — no debería pasar
    // (run.js lo escribe antes de llamar startNew) pero no es motivo de abort.
  }

  const fresh = {
    songId,
    titulo,
    isRedo: !!isRedo,
    stage: STAGES.GENERATED,
    songTxtHash,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(STATE_PATH, fresh);
  return fresh;
}

// Lógica pura (sin tocar disco) para poder testearla sin pisar el state.json
// real del pipeline — ver test/pipeline-state.test.js. Devuelve { ok: true }
// si el hash coincide, o no hay hash guardado en `stateObj` (estado viejo,
// o songTxtHash falló al escribirse) — en ese caso no hay nada confiable que
// comparar, así que no se reporta como problema. Solo `{ ok: false }` cuando
// hay una divergencia real y verificable.
function songTxtMatchesState(currentContent, stateObj) {
  if (!stateObj || !stateObj.songTxtHash) return { ok: true };
  const currentHash = hashContent(currentContent);
  if (currentHash === stateObj.songTxtHash) return { ok: true };
  return {
    ok: false,
    reason: `song.txt cambió desde que se generó (hash ${stateObj.songTxtHash} → ${currentHash}). ` +
      'Si vos lo editaste a mano, ignorá este aviso. Si no, algo (otro proceso, un --dry-run suelto) lo pisó.',
  };
}

// Compara el contenido ACTUAL de song.txt contra el hash guardado por
// startNew() en el state.json real del pipeline.
function checkSongTxtContent(currentContent) {
  return songTxtMatchesState(currentContent, read());
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

module.exports = { STAGES, STATE_PATH, read, write, startNew, checkSongId, checkSongTxtContent, songTxtMatchesState, hashContent, atomicWriteJson };
