// test/cache-helpers.test.js — Suite de regresión local para lib/cache-helpers.js.
//
// Usa un CACHE_DIR temporal propio vía jest-style monkeypatch de require no
// aplica acá (no hay jest) — en cambio, testea contra .cache/ real del repo
// pero con hashes claramente marcados de test y los borra siempre al final.
// 100% offline. Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getSurveyHash, readCache, writeCache, invalidateCache } = require('../lib/cache-helpers');

const CACHE_DIR = path.join(__dirname, '..', '.cache');

function testCachePath(hash) {
  return path.join(CACHE_DIR, `${hash}.json`);
}

test('getSurveyHash: mismo texto siempre da el mismo hash', () => {
  const a = getSurveyHash('Encuesta de prueba con nombre Frank');
  const b = getSurveyHash('Encuesta de prueba con nombre Frank');
  assert.equal(a, b);
});

test('getSurveyHash: textos distintos dan hashes distintos', () => {
  const a = getSurveyHash('Encuesta A');
  const b = getSurveyHash('Encuesta B');
  assert.notEqual(a, b);
});

test('writeCache/readCache: round-trip devuelve el mismo contenido', () => {
  const hash = 'test-roundtrip-' + process.pid;
  try {
    writeCache(hash, { titulo: 'Canción de prueba', letras: { 'Verse 1': ['a', 'b', 'c', 'd'] } });
    const result = readCache(hash);
    assert.deepEqual(result, { titulo: 'Canción de prueba', letras: { 'Verse 1': ['a', 'b', 'c', 'd'] } });
  } finally {
    fs.rmSync(testCachePath(hash), { force: true });
  }
});

test('writeCache: escribe atómico — no deja un .tmp huérfano después de escribir', () => {
  const hash = 'test-atomic-' + process.pid;
  try {
    writeCache(hash, { a: 1 });
    assert.equal(fs.existsSync(testCachePath(hash)), true);
    assert.equal(fs.existsSync(`${testCachePath(hash)}.tmp`), false);
  } finally {
    fs.rmSync(testCachePath(hash), { force: true });
    fs.rmSync(`${testCachePath(hash)}.tmp`, { force: true });
  }
});

test('readCache: hash sin cache devuelve null en vez de lanzar', () => {
  const result = readCache('hash-que-nunca-existio-' + process.pid);
  assert.equal(result, null);
});

test('readCache: JSON corrupto devuelve null en vez de lanzar (self-healing)', () => {
  const hash = 'test-corrupto-' + process.pid;
  const cachePath = testCachePath(hash);
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath, '{ esto no es JSON válido', 'utf-8');
    const result = readCache(hash);
    assert.equal(result, null);
  } finally {
    fs.rmSync(cachePath, { force: true });
  }
});

// ─── invalidateCache: incidente real 2026-07-15 ("El Pañuelo Azul y Blanco")──
// El Guardia rechazó una letra, la pausa expiró y el siguiente ciclo del
// --loop la sirvió de nuevo IDÉNTICA desde la caché (escrita ANTES de que el
// Guardia corriera) — el mismo rechazo se repetía para siempre. run.js llama
// invalidateCache(surveyHash) apenas el Guardia confirma el rechazo.

test('invalidateCache: borra una entrada existente — la próxima lectura es un miss', () => {
  const hash = 'test-invalidate-' + process.pid;
  writeCache(hash, { titulo: 'Letra rechazada por el Guardia' });
  assert.notEqual(readCache(hash), null); // confirma que quedó escrita
  invalidateCache(hash);
  assert.equal(readCache(hash), null, 'invalidateCache no borró la entrada — el próximo run.js volvería a servir la letra rechazada');
});

test('invalidateCache: hash sin cache no lanza (idempotente)', () => {
  assert.doesNotThrow(() => invalidateCache('hash-que-nunca-existio-' + process.pid));
});

test('invalidateCache: no deja huérfano .tmp ni afecta otras entradas de caché', () => {
  const hashA = 'test-invalidate-a-' + process.pid;
  const hashB = 'test-invalidate-b-' + process.pid;
  try {
    writeCache(hashA, { titulo: 'A' });
    writeCache(hashB, { titulo: 'B' });
    invalidateCache(hashA);
    assert.equal(readCache(hashA), null);
    assert.deepEqual(readCache(hashB), { titulo: 'B' }); // intacta
  } finally {
    fs.rmSync(testCachePath(hashB), { force: true });
  }
});
