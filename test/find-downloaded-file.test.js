// Tests de findDownloadedFile (lib/suno-create-dl.js): localiza el archivo que
// Chrome descargó por título + mtime. Documenta el contrato real (y el riesgo
// conocido: dos descargas del MISMO título se distinguen solo por mtime — por
// eso el loop de descargas de createAndDownload es SECUENCIAL; ver LESSONS.md).
// Todo sobre una carpeta temporal propia, nunca toca Downloads/suno real.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findDownloadedFile } = require('../lib/suno-create-dl');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'find-dl-test-'));
}

function touch(dir, name, mtimeMs) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'x');
  const t = new Date(mtimeMs);
  fs.utimesSync(p, t, t);
  return p;
}

test('findDownloadedFile: encuentra el archivo del título modificado después de startTime', () => {
  const dir = makeTmpDir();
  try {
    const now = Date.now();
    const expected = touch(dir, 'Mi Cancion.mp3', now);
    const found = findDownloadedFile(dir, 'Mi Cancion', now - 1000);
    assert.strictEqual(found, expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findDownloadedFile: ignora archivos anteriores a startTime (canción vieja del mismo título)', () => {
  const dir = makeTmpDir();
  try {
    const now = Date.now();
    touch(dir, 'Mi Cancion.mp3', now - 60 * 60 * 1000); // descarga de hace 1h
    const found = findDownloadedFile(dir, 'Mi Cancion', now - 1000);
    assert.strictEqual(found, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findDownloadedFile: acepta el sufijo nativo de Chrome " (1)" y elige el más reciente', () => {
  const dir = makeTmpDir();
  try {
    const now = Date.now();
    touch(dir, 'Mi Cancion.mp3', now - 5000);
    const newer = touch(dir, 'Mi Cancion (1).mp3', now);
    const found = findDownloadedFile(dir, 'Mi Cancion', now - 10000);
    assert.strictEqual(found, newer);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findDownloadedFile: dos archivos del mismo título dentro de la ventana → gana el mtime más nuevo (contrato A/B: por esto las descargas corren secuenciales)', () => {
  const dir = makeTmpDir();
  try {
    const now = Date.now();
    const versionA = touch(dir, 'Mi Cancion.mp3', now - 3000);
    const versionB = touch(dir, 'Mi Cancion (1).mp3', now - 1000);
    // Si A ya se descargó y NO se renombró/reclamó antes de bajar B, la
    // búsqueda de A devolvería el archivo de B. El código real evita esto
    // renombrando cada descarga apenas se confirma (loop secuencial).
    assert.strictEqual(findDownloadedFile(dir, 'Mi Cancion', now - 10000), versionB);
    // Tras "reclamar" B (renombrarlo fuera del patrón), A vuelve a ser el match.
    fs.renameSync(versionB, path.join(dir, '_temp_b.mp3'));
    assert.strictEqual(findDownloadedFile(dir, 'Mi Cancion', now - 10000), versionA);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findDownloadedFile: títulos con caracteres especiales de regex no rompen la búsqueda', () => {
  const dir = makeTmpDir();
  try {
    const now = Date.now();
    const expected = touch(dir, 'Amor (Version Final) + Fe.mp3', now);
    const found = findDownloadedFile(dir, 'Amor (Version Final) + Fe', now - 1000);
    assert.strictEqual(found, expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
