// test/song-file.test.js — Suite de regresión local para lib/song-file.js.
//
// Fuente única de parseSongFile (antes duplicada en suno-fill.js y
// flow-submit.js — ver comentario en lib/song-file.js). 100% offline.
// Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSongFile } = require('../lib/song-file');

function buildSongTxt({ withNotes = true, withDashSeparator = true } = {}) {
  const header = [
    '**Título:** El Vals Que Nunca Olvido',
    '**Voz:** Masculina',
    '**Trato:** vos',
    '**Estilo Suno:** Balada, piano suave, Latin American Spanish, neutral accent, seseo',
  ].join('\n');

  const lyrics = [
    '[Verse 1]',
    'Una noche de vals el salón se quedó en silencio',
    'Tenías quince años y el mundo entero te miraba',
    'Yo te tomé de la mano sin saber qué decirte',
    'Y ahí entendí que el tiempo se me iba de las manos',
    '',
    '[Chorus 1]',
    'Johelyn, mi niña tierna y cariñosa',
  ].join('\n');

  const qaChecklist = '**QA Checklist:**\n- 6_secciones_en_orden: ✓';
  const notesLine = 'NOTES: 7.03.2026. Hector. PS0180. Letra + Suno. Song ID: abc123';

  const parts = [header, '', withDashSeparator ? '---' : '', '', lyrics, '', qaChecklist];
  if (withNotes) parts.push('', notesLine);
  return parts.join('\n');
}

test('parseSongFile: extrae título, voz, estilo y letra con separador ---', () => {
  const { titulo, voz, estilo, lyrics, notes } = parseSongFile(buildSongTxt());
  assert.equal(titulo, 'El Vals Que Nunca Olvido');
  assert.equal(voz, 'Masculina');
  assert.equal(estilo, 'Balada, piano suave, Latin American Spanish, neutral accent, seseo');
  assert.match(lyrics, /^\[Verse 1\]/);
  assert.ok(!lyrics.includes('QA Checklist'));
  assert.ok(!lyrics.includes('NOTES:'));
  assert.match(notes, /Song ID: abc123/);
});

test('parseSongFile: extrae songId de la línea NOTES (usado por lib/sheets-core.js)', () => {
  const { songId } = parseSongFile(buildSongTxt());
  assert.equal(songId, 'abc123');
});

test('parseSongFile: sin NOTES, songId es null', () => {
  const { songId } = parseSongFile(buildSongTxt({ withNotes: false }));
  assert.equal(songId, null);
});

test('parseSongFile: sin separador --- corta en QA Checklist/Advertencias/NOTES', () => {
  const { lyrics } = parseSongFile(buildSongTxt({ withDashSeparator: false }));
  assert.match(lyrics, /^\[Verse 1\]/);
  assert.ok(!lyrics.includes('QA Checklist'));
});

test('parseSongFile: sin NOTES devuelve notes null sin romper el resto', () => {
  const { titulo, lyrics, notes } = parseSongFile(buildSongTxt({ withNotes: false }));
  assert.equal(titulo, 'El Vals Que Nunca Olvido');
  assert.match(lyrics, /^\[Verse 1\]/);
  assert.equal(notes, null);
});

test('parseSongFile: contenido vacío/corrupto devuelve todos los campos null', () => {
  const parsed = parseSongFile('⚠️ ERROR CRÍTICO: la generación de letra falló.');
  assert.equal(parsed.titulo, null);
  assert.equal(parsed.voz, null);
  assert.equal(parsed.estilo, null);
  assert.equal(parsed.lyrics, null);
});
