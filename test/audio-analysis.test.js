// test/audio-analysis.test.js — Suite de regresión local para pickBestVersion
// (lib/audio-analysis.js) — decide qué versión sube automáticamente al Flow.
//
// 100% offline: construye reportes falsos a mano, nunca corre ffmpeg/Whisper/
// CLAP de verdad. Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickBestVersion, lastMeaningfulLine } = require('../lib/audio-analysis');

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
    demucs: { used: false, vocalPresence: null, error: null },
    clap: { score: null, dimensions: null, error: null },
    ...overrides,
  };
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
