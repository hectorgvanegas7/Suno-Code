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

module.exports = { parseSongFile };
