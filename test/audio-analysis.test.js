// test/audio-analysis.test.js — Suite de regresión local para pickBestVersion
// (lib/audio-analysis.js) — decide qué versión sube automáticamente al Flow.
//
// 100% offline: construye reportes falsos a mano, nunca corre ffmpeg/Whisper/
// CLAP/NISQA de verdad. Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickBestVersion, lastMeaningfulLine, checkNamePacing, detectMergedWordPairs, computeMissingNames, detectTruncatedWords, countVowelsEs } = require('../lib/audio-analysis');
const { applyPhoneticReplacements } = require('../lib/song-file');

function buildReport(overrides = {}) {
  return {
    label: 'Versión',
    durationOk: true,
    abruptCutoff: false,
    clippingFlag: false,
    levenshteinScore: 0.95,
    titleCantado: false,
    tagLeaking: [],
    missingNames: [],
    nameAudioChecks: [],
    namePacingIssues: [],
    pacingIssues: [],
    demucs: { used: false, vocalPresence: null, error: null },
    clap: { score: null, dimensions: null, error: null },
    nisqa: { score: null, mos: null, dimensions: null, error: null },
    ...overrides,
  };
}

// Fabrica un segment con words[] para probar checkNamePacing/detectMergedWordPairs
// sin correr Whisper de verdad.
function buildSegment(words) {
  return { start: words[0].start, end: words[words.length - 1].end, text: words.map((w) => w.word).join(' '), words };
}

test('pickBestVersion: sin Versión B, recomienda A sin comparar', () => {
  const reportA = buildReport();
  const result = pickBestVersion(reportA, null);
  assert.equal(result.recommended, 'A');
  assert.equal(result.scoreB, null);
});

test('pickBestVersion: A y B idénticos → empate técnico, gana A por defecto', () => {
  const reportA = buildReport();
  const reportB = buildReport();
  const result = pickBestVersion(reportA, reportB);
  assert.equal(result.recommended, 'A');
  assert.equal(result.scoreA, result.scoreB);
  assert.match(result.reason, /Empate técnico/);
});

test('pickBestVersion: B con nombre ausente pierde contra A limpia', () => {
  const reportA = buildReport();
  const reportB = buildReport({ missingNames: ['frank'] });
  const result = pickBestVersion(reportA, reportB);
  assert.equal(result.recommended, 'A');
  assert.ok(result.scoreA > result.scoreB);
});

test('pickBestVersion: B con pronunciación no confirmada por el re-chequeo sin pista pierde contra A limpia', () => {
  const reportA = buildReport();
  const reportB = buildReport({ nameAudioChecks: [{ name: 'al', spelledAs: 'Aal', confirmed: false, clipPath: 'x.wav', unprimedText: 'jal' }] });
  const result = pickBestVersion(reportA, reportB);
  assert.equal(result.recommended, 'A');
  assert.ok(result.scoreA > result.scoreB);
});

test('pickBestVersion: reportes sin nameAudioChecks (forma vieja del objeto) no rompen scoreReport', () => {
  const reportA = buildReport({ nameAudioChecks: undefined });
  const reportB = buildReport({ nameAudioChecks: undefined });
  assert.doesNotThrow(() => pickBestVersion(reportA, reportB));
});

test('pickBestVersion: B con instrumental accidental (sin voz) pierde contra A', () => {
  const reportA = buildReport();
  const reportB = buildReport({ demucs: { used: true, vocalPresence: true, error: null } });
  const result = pickBestVersion(reportA, reportB);
  assert.equal(result.recommended, 'A');
});

test('pickBestVersion: B con duración fuera de rango y corte abrupto pierde contra A', () => {
  const reportA = buildReport();
  const reportB = buildReport({ durationOk: false, abruptCutoff: true });
  const result = pickBestVersion(reportA, reportB);
  assert.equal(result.recommended, 'A');
  assert.match(result.reason, /duración OK, B no/);
});

test('pickBestVersion: A con alucinación grave (Levenshtein bajo) pierde contra B', () => {
  const reportA = buildReport({ levenshteinScore: 0.5 });
  const reportB = buildReport({ levenshteinScore: 0.95 });
  const result = pickBestVersion(reportA, reportB);
  assert.equal(result.recommended, 'B');
});

test('pickBestVersion: CLAP alto en B (>85) le da una ventaja informativa sobre A neutral', () => {
  const reportA = buildReport();
  const reportB = buildReport({ clap: { score: 90, dimensions: {}, error: null } });
  const result = pickBestVersion(reportA, reportB);
  assert.equal(result.recommended, 'B');
});

test('pickBestVersion: CLAP bajo (<50) penaliza aunque el resto esté limpio', () => {
  const reportA = buildReport({ clap: { score: 30, dimensions: {}, error: null } });
  const reportB = buildReport();
  const result = pickBestVersion(reportA, reportB);
  assert.equal(result.recommended, 'B');
});

test('pickBestVersion: NISQA alto en B (>85) le da una ventaja informativa sobre A neutral', () => {
  const reportA = buildReport();
  const reportB = buildReport({ nisqa: { score: 90, mos: 4.6, dimensions: {}, error: null } });
  const result = pickBestVersion(reportA, reportB);
  assert.equal(result.recommended, 'B');
});

test('pickBestVersion: NISQA bajo (<50) penaliza aunque el resto esté limpio', () => {
  const reportA = buildReport({ nisqa: { score: 30, mos: 2.2, dimensions: {}, error: null } });
  const reportB = buildReport();
  const result = pickBestVersion(reportA, reportB);
  assert.equal(result.recommended, 'B');
});

test('pickBestVersion: B con nombre pegado a palabra vecina pierde contra A limpia', () => {
  const reportA = buildReport();
  const reportB = buildReport({
    namePacingIssues: [{ name: 'clara', spelledAs: 'Clara', mergedAfter: true, gapAfterS: 0.01, clipPath: 'x.wav' }],
  });
  const result = pickBestVersion(reportA, reportB);
  assert.equal(result.recommended, 'A');
  assert.ok(result.scoreA > result.scoreB);
});

test('checkNamePacing: palabra siguiente pegada (hueco 10ms) se detecta como mergedAfter', () => {
  const segments = [buildSegment([
    { word: 'Clara', start: 10.0, end: 10.3, probability: 0.9 },
    { word: 'tú', start: 10.31, end: 10.5, probability: 0.9 },
  ])];
  const result = checkNamePacing('Clara', segments);
  assert.ok(result);
  assert.equal(result.mergedAfter, true);
  assert.equal(result.mergedBefore, false);
});

test('checkNamePacing: hueco normal (0.3s) no dispara ningún merge', () => {
  const segments = [buildSegment([
    { word: 'Clara', start: 10.0, end: 10.3, probability: 0.9 },
    { word: 'tú', start: 10.6, end: 10.8, probability: 0.9 },
  ])];
  const result = checkNamePacing('Clara', segments);
  assert.equal(result, null);
});

test('checkNamePacing: sin word timestamps devuelve null sin lanzar', () => {
  const segments = [{ start: 0, end: 1, text: 'Clara tú', words: undefined }];
  assert.doesNotThrow(() => {
    const result = checkNamePacing('Clara', segments);
    assert.equal(result, null);
  });
});

test('detectMergedWordPairs: encuentra el par con hueco por debajo del umbral general', () => {
  const segments = [buildSegment([
    { word: 'hola', start: 0, end: 0.3, probability: 0.9 },
    { word: 'mundo', start: 0.31, end: 0.6, probability: 0.9 },
    { word: 'feliz', start: 0.9, end: 1.2, probability: 0.9 },
  ])];
  const pairs = detectMergedWordPairs(segments);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].wordA, 'hola');
  assert.equal(pairs[0].wordB, 'mundo');
});

test('lastMeaningfulLine: devuelve la última línea de un traceback de Python (el mensaje real, no "Traceback...")', () => {
  const stderr = [
    'Traceback (most recent call last):',
    '  File "lib/transcribe.py", line 164, in <module>',
    '    main()',
    'FileNotFoundError: [Errno 2] No such file or directory: \'x.mp3\'',
  ].join('\n');
  assert.equal(lastMeaningfulLine(stderr), "FileNotFoundError: [Errno 2] No such file or directory: 'x.mp3'");
});

test('lastMeaningfulLine: ignora líneas en blanco al final', () => {
  const stderr = 'error real\n\n\n';
  assert.equal(lastMeaningfulLine(stderr), 'error real');
});

test('lastMeaningfulLine: trunca líneas muy largas', () => {
  const longLine = 'x'.repeat(400);
  const result = lastMeaningfulLine(longLine, 300);
  assert.equal(result.length, 301); // 300 chars + el "…"
  assert.ok(result.endsWith('…'));
});

// ─── Regresión 2026-07-08: falsos "nombre ausente" por comparar contra la ────
// letra CRUDA en vez de la letra con el reemplazo fonético ya aplicado. La
// migración a Windows movió el reemplazo fonético a un paso posterior
// (applyPhoneticReplacements en suno-fill.js/verify-audio.js) y dejó
// `lyricsText` crudo en algunos call-sites — esto reproduce el bug real y
// confirma el fix de verify-audio.js (aplicar applyPhoneticReplacements ANTES
// de llamar a analyzeAudio/computeMissingNames).
function buildJamieLyrics() {
  return [
    '[Verse 1]',
    'Algo algo algo algo',
    'algo algo algo algo',
    'algo algo algo algo',
    'algo algo algo algo',
    '',
    '[Chorus 1]',
    'Jamie llegaste con amor y luz',
    'segunda linea del coro',
    'tercera linea del coro',
    'cuarta linea del coro',
  ].join('\n');
}
const JAMIE_TRANSCRIPTION = 'algo algo algo algo yeimi llegaste con amor y luz segunda linea del coro tercera linea del coro cuarta linea del coro';

test('computeMissingNames: SIN aplicar el reemplazo fonético reintroduce el falso "ausente" (bug 2026-07-08)', () => {
  const rawLyrics = buildJamieLyrics(); // "Jamie" crudo, como en song.txt si el LLM no siguió la regla estricta
  const missing = computeMissingNames(['Jamie'], rawLyrics, JAMIE_TRANSCRIPTION, []);
  assert.deepEqual(missing, ['Jamie']);
});

test('computeMissingNames: CON el reemplazo fonético aplicado (como hace verify-audio.js) no marca falso "ausente"', () => {
  const rawLyrics = buildJamieLyrics();
  const phoneticLyrics = applyPhoneticReplacements(rawLyrics); // "Jamie" -> "Yeimi" vía lib/name-dictionary.json
  const missing = computeMissingNames(['Jamie'], phoneticLyrics, JAMIE_TRANSCRIPTION, []);
  assert.deepEqual(missing, []);
});

test('computeMissingNames: nombre realmente ausente de la transcripción sí se marca', () => {
  const phoneticLyrics = applyPhoneticReplacements(buildJamieLyrics());
  const missing = computeMissingNames(['Jamie'], phoneticLyrics, 'una transcripcion que no menciona a nadie por su nombre', []);
  assert.deepEqual(missing, ['Jamie']);
});

// ─── detectTruncatedWords / countVowelsEs (pedido 2026-07-09) ────────────────
// mp3Path apunta a un archivo que NO existe a propósito: getMeanVolumeDb y
// extractAudioClip usan ffmpeg vía execFileAsync, que nunca lanza (resuelve
// {error} y el caller devuelve null/false) — así el test queda 100% offline
// (sin depender de que ffmpeg esté instalado) y solo ejercita la lógica pura
// de filtrado por duración+probability, con clipPath/volumeDropDb en null.
const FAKE_MP3_PATH = 'no-existe-para-el-test.mp3';

test('countVowelsEs: cuenta vocales españolas incluyendo tildes', () => {
  assert.equal(countVowelsEs('Frank'), 1);
  assert.equal(countVowelsEs('María'), 3);
  assert.equal(countVowelsEs('canción'), 3);
  assert.equal(countVowelsEs(''), 1); // mínimo 1, nunca 0
});

test('detectTruncatedWords: palabra corta + probability baja se marca (tooShort confirma)', async () => {
  const segments = [buildSegment([
    { word: 'Frank', start: 10.0, end: 10.05, probability: 0.3 }, // 0.05s para 1 vocal (esperado ~0.09s) + prob baja
  ])];
  const result = await detectTruncatedWords(FAKE_MP3_PATH, segments);
  assert.equal(result.length, 1);
  assert.equal(result[0].word, 'Frank');
  assert.equal(result[0].tooShort, true);
  assert.equal(result[0].clipPath, null); // ffmpeg no disponible sobre un archivo inexistente
  assert.equal(result[0].volumeDropDb, null);
  assert.equal(result[0].volumeDropConfirmed, false);
});

test('detectTruncatedWords: probability baja + duración normal SÍ es candidata (rediseño 2026-07-09), pero sin confirmación de volumen (ffmpeg no disponible) no se reporta', async () => {
  // El caso real "Fran-" en vez de "Frank" conserva su vocal cantada larga —
  // la duración casi no cambia. Por eso probability baja sola alcanza para
  // MEDIR la palabra; para reportarla hace falta que la confirme la duración
  // corta O la caída de volumen (acá ffmpeg no corre → sin confirmación → []).
  const segments = [buildSegment([
    { word: 'Frank', start: 10.0, end: 10.5, probability: 0.3 }, // 0.5s, de sobra para 1 vocal
  ])];
  const result = await detectTruncatedWords(FAKE_MP3_PATH, segments);
  assert.deepEqual(result, []);
});

test('detectTruncatedWords: palabra corta con probability ALTA no se marca (Whisper confía en la transcripción)', async () => {
  const segments = [buildSegment([
    { word: 'Frank', start: 10.0, end: 10.05, probability: 0.95 },
  ])];
  const result = await detectTruncatedWords(FAKE_MP3_PATH, segments);
  assert.deepEqual(result, []);
});

test('detectTruncatedWords: sin segments devuelve lista vacía', async () => {
  assert.deepEqual(await detectTruncatedWords(FAKE_MP3_PATH, []), []);
});
