// test/hygiene.test.js — Suite de regresión local para lib/hygiene.js.
//
// Usa una carpeta temporal propia (os.tmpdir()) — NUNCA toca logs/ ni
// screenshots/ reales del repo. 100% offline. Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanOldFiles, trimGrowingJsonlFiles, RETENTION_DAYS, SUNO_WORKING_RETENTION_DAYS } = require('../lib/hygiene');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cancioneterna-hygiene-test-'));
}

test('cleanOldFiles: borra archivos más viejos que la retención, conserva los recientes', () => {
  const dir = makeTmpDir();
  try {
    const oldFile = path.join(dir, 'run-viejo.log');
    const newFile = path.join(dir, 'run-nuevo.log');
    fs.writeFileSync(oldFile, 'contenido viejo');
    fs.writeFileSync(newFile, 'contenido nuevo');

    const now = Date.now();
    const fortyDaysAgo = now - 40 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldFile, fortyDaysAgo / 1000, fortyDaysAgo / 1000);

    const result = cleanOldFiles(dir, { now, retentionMs: 30 * 24 * 60 * 60 * 1000 });

    assert.deepEqual(result.deleted, ['run-viejo.log']);
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(newFile), true);
    assert.deepEqual(result.errors, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanOldFiles: carpeta vacía no borra nada ni tira error', () => {
  const dir = makeTmpDir();
  try {
    const result = cleanOldFiles(dir);
    assert.deepEqual(result.deleted, []);
    assert.deepEqual(result.errors, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanOldFiles: directorio inexistente devuelve error en vez de lanzar', () => {
  const result = cleanOldFiles(path.join(os.tmpdir(), 'no-existe-' + Date.now()));
  assert.deepEqual(result.deleted, []);
  assert.equal(result.errors.length, 1);
});

test('cleanOldFiles: ignora subdirectorios, solo borra archivos', () => {
  const dir = makeTmpDir();
  try {
    const subDir = path.join(dir, 'una-subcarpeta');
    fs.mkdirSync(subDir);
    const now = Date.now();
    const veryOld = now - 100 * 24 * 60 * 60 * 1000;
    fs.utimesSync(subDir, veryOld / 1000, veryOld / 1000);

    const result = cleanOldFiles(dir, { now, retentionMs: 30 * 24 * 60 * 60 * 1000 });
    assert.deepEqual(result.deleted, []);
    assert.equal(fs.existsSync(subDir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Regresión 2026-07-08: los .jsonl append-only (auto-submit-events,
// phonetic-candidates, pacing-feedback) resetean su mtime en cada línea
// nueva, así que cleanOldFiles (basado en edad) nunca los toca — crecerían
// para siempre. trimGrowingJsonlFiles los recorta por CANTIDAD de líneas.
test('trimGrowingJsonlFiles: recorta un .jsonl que excede maxLines a las últimas N líneas', () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, 'auto-submit-events.jsonl');
    const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ n: i }));
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');

    const result = trimGrowingJsonlFiles(dir, { maxLines: 3 });

    assert.deepEqual(result.trimmed, [{ name: 'auto-submit-events.jsonl', from: 10, to: 3 }]);
    const remaining = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    assert.deepEqual(remaining, [lines[7], lines[8], lines[9]]); // las últimas 3, no las primeras
    assert.deepEqual(result.errors, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('trimGrowingJsonlFiles: no toca un .jsonl que todavía no excede maxLines', () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, 'phonetic-candidates.jsonl');
    const original = ['{"a":1}', '{"a":2}'].join('\n') + '\n';
    fs.writeFileSync(filePath, original, 'utf-8');

    const result = trimGrowingJsonlFiles(dir, { maxLines: 5 });

    assert.deepEqual(result.trimmed, []);
    assert.equal(fs.readFileSync(filePath, 'utf-8'), original);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Retención de MP3s (2026-07-14, pedido de Hector: SSD lleno — Downloads/suno
// pesaba 824M, mp3/ 367M). Dos retenciones DISTINTAS a propósito: 7 días para
// las copias de TRABAJO en Downloads/suno (pura redundancia efímera, la fuente
// real es mp3/), 30 días (RETENTION_DAYS, el default de siempre) para el
// respaldo archivado en mp3/ — es la ÚNICA copia de una canción ya entregada.
test('constantes de retención de MP3: Downloads/suno (7 días) es más corta que mp3/ (30 días, el default)', () => {
  assert.equal(SUNO_WORKING_RETENTION_DAYS, 7);
  assert.equal(RETENTION_DAYS, 30);
  assert.ok(SUNO_WORKING_RETENTION_DAYS < RETENTION_DAYS, 'Downloads/suno debe purgarse más rápido que el respaldo archivado');
});

test('cleanOldFiles con retención de 7 días: un MP3 de 10 días se borra, uno de 3 días sobrevive', () => {
  const dir = makeTmpDir();
  try {
    const oldMp3 = path.join(dir, 'Cancion Vieja.mp3');
    const recentMp3 = path.join(dir, 'Cancion Reciente.mp3');
    fs.writeFileSync(oldMp3, 'audio falso viejo');
    fs.writeFileSync(recentMp3, 'audio falso reciente');

    const now = Date.now();
    fs.utimesSync(oldMp3, (now - 10 * 24 * 60 * 60 * 1000) / 1000, (now - 10 * 24 * 60 * 60 * 1000) / 1000);
    fs.utimesSync(recentMp3, (now - 3 * 24 * 60 * 60 * 1000) / 1000, (now - 3 * 24 * 60 * 60 * 1000) / 1000);

    const result = cleanOldFiles(dir, { now, retentionMs: SUNO_WORKING_RETENTION_DAYS * 24 * 60 * 60 * 1000 });

    assert.deepEqual(result.deleted, ['Cancion Vieja.mp3']);
    assert.equal(fs.existsSync(recentMp3), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanOldFiles con retención de 30 días (mp3/): un respaldo de 10 días sobrevive (no llega a los 30)', () => {
  const dir = makeTmpDir();
  try {
    const backup = path.join(dir, 'abc123 - Mi Cancion.mp3');
    fs.writeFileSync(backup, 'respaldo falso');
    const now = Date.now();
    fs.utimesSync(backup, (now - 10 * 24 * 60 * 60 * 1000) / 1000, (now - 10 * 24 * 60 * 60 * 1000) / 1000);

    const result = cleanOldFiles(dir, { now, retentionMs: RETENTION_DAYS * 24 * 60 * 60 * 1000 });

    assert.deepEqual(result.deleted, []);
    assert.equal(fs.existsSync(backup), true, 'a los 10 días el respaldo archivado NO debe borrarse (retención de 30)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('trimGrowingJsonlFiles: ignora archivos que no son .jsonl', () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, 'run-2026.log');
    fs.writeFileSync(filePath, Array.from({ length: 20 }, () => 'línea').join('\n'));

    const result = trimGrowingJsonlFiles(dir, { maxLines: 3 });

    assert.deepEqual(result.trimmed, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
