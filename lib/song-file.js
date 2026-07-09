// lib/song-file.js — Parser único de song.txt.
//
// suno-fill.js y flow-submit.js tenían cada uno su propia copia de
// parseSongFile (casi idéntica, pero no exactamente — divergencia real: solo
// flow-submit.js parseaba `notes`). Cualquier función de navegación/parseo
// duplicada en más de un script es una fuente conocida de bugs en este repo
// (ver el caso "Enter Flow + Assign" en LESSONS.md, 2026-06-28) — un fix en
// una copia no se propaga a la otra. Fuente única acá, cubierta por
// test/song-file.test.js.
//
// El corte de la letra siempre para en lo primero que aparezca entre
// '---', '**QA Checklist:**', '**Advertencias:**' o 'NOTES:' (song.txt puede
// no tener el separador '---' si vino de un song.txt viejo/manual).

const fs = require('fs');
const crypto = require('crypto');

function parseSongFile(content) {
  const titulo = (content.match(/\*\*Título:\*\*\s*(.+)/i) || [])[1]?.trim() || null;
  const voz = (content.match(/\*\*Voz:\*\*\s*(.+)/i) || [])[1]?.trim() || null;
  const estilo = (content.match(/\*\*Estilo Suno:\*\*\s*(.+)/i) || [])[1]?.trim() || null;

  const verseIndex = content.search(/\[Verse 1\]/i);
  let lyricsEndIndex = content.indexOf('---', verseIndex);
  if (lyricsEndIndex === -1) {
    const qa = content.search(/\*\*QA Checklist:\*\*/i);
    const adv = content.search(/\*\*Advertencias:\*\*/i);
    const notes = content.search(/NOTES:/i);
    lyricsEndIndex = [qa, adv, notes].filter((i) => i !== -1).sort((a, b) => a - b)[0];
  }
  const lyrics = verseIndex !== -1
    ? content.slice(verseIndex, lyricsEndIndex).trim()
    : null;

  const notesMatch = content.match(/NOTES:\s*([\s\S]+)/i);
  const notes = notesMatch ? notesMatch[1].trim() : null;

  const songIdMatch = content.match(/Song ID:\s*([^\s\n]+)/i);
  const songId = songIdMatch ? songIdMatch[1].trim() : null;

  return { titulo, voz, estilo, lyrics, notes, songId };
}

// Quita "Song ID: xxxx" de la nota cruda de song.txt para el campo de Notas
// del Flow — el Flow ya tiene su propio campo de Song ID, repetirlo ahí es
// redundante. song.txt conserva la línea NOTES completa (con Song ID) para
// tracking interno.
function buildFlowNotes(rawNotes) {
  return rawNotes.replace(/\s*Song ID:\s*\S+/i, '').trim();
}

// Nota final para el campo de Notas del Flow: la nota estándar de song.txt
// SIEMPRE presente, y si es REDO, "Redo Fix, corregido" agregado DEBAJO —
// nunca en su lugar. Bug real arreglado 2026-07-03/04 (ver LESSONS.md): antes
// isRedo reemplazaba la nota entera por solo "Redo Fix, corregido", perdiendo
// la nota estándar en cada REDO.
function buildRedoAwareNotes(rawNotes, { isRedo = false } = {}) {
  const standard = buildFlowNotes(rawNotes);
  return isRedo ? `${standard}\n\nRedo Fix, corregido` : standard;
}

const nameDictionary = require('./name-dictionary.json');

function applyPhoneticReplacements(lyrics) {
  if (!lyrics) return lyrics;
  let result = lyrics;
  for (const [originalName, phonetic] of Object.entries(nameDictionary)) {
    const regex = new RegExp(`\\b${originalName}\\b`, 'gi');
    result = result.replace(regex, (match) => {
      const isCapitalized = match[0] === match[0].toUpperCase();
      if (isCapitalized) {
        return phonetic.charAt(0).toUpperCase() + phonetic.slice(1);
      }
      return phonetic.toLowerCase();
    });
  }
  return result;
}

// Cache de la letra YA fonetizada (lo que realmente se escribió en Suno),
// keyed por hash de song.txt. Fuente única entre suno-fill.js (la escribe,
// justo antes de tipear en Suno) y verify-audio.js (la lee para comparar
// contra la transcripción) — evita que ambos recalculen `applyPhoneticReplacements`
// por separado y diverjan si uno de los dos call-sites queda desactualizado
// (exactamente la clase de bug de la regresión 2026-07-08, ver LESSONS.md).
// Si el hash no matchea (song.txt cambió, o no hay cache todavía) el caller
// debe recalcular con applyPhoneticReplacements() — nunca confiar en un cache
// de otra canción.
function hashSongContent(content) {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 16);
}

function writeSunoLyricsCache(cachePath, songContent, phoneticLyrics) {
  try {
    fs.writeFileSync(cachePath, JSON.stringify({
      songTxtHash: hashSongContent(songContent),
      lyrics: phoneticLyrics,
      writtenAt: new Date().toISOString(),
    }, null, 2), 'utf-8');
  } catch (e) {
    console.warn(`⚠️  No se pudo escribir el cache de letra fonetizada (${cachePath}): ${e.message}`);
  }
}

function readSunoLyricsCache(cachePath, songContent) {
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    if (cached.songTxtHash === hashSongContent(songContent) && typeof cached.lyrics === 'string') {
      return cached.lyrics;
    }
  } catch {
    // No existe, está corrupto, o no hay match — el caller recalcula.
  }
  return null;
}

module.exports = {
  parseSongFile,
  buildFlowNotes,
  buildRedoAwareNotes,
  applyPhoneticReplacements,
  writeSunoLyricsCache,
  readSunoLyricsCache,
};
