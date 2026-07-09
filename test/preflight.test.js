// test/preflight.test.js — Suite de regresión local para la parte de disco
// de lib/preflight.js (checkDiskSpace/getFreeDiskGB). El resto de
// runPreflight depende de credenciales/env reales del proyecto y no se
// testea acá. 100% offline. Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkDiskSpace, getFreeDiskGB } = require('../lib/preflight');

test('getFreeDiskGB: devuelve un número positivo para el directorio del repo', () => {
  const freeGB = getFreeDiskGB();
  assert.equal(typeof freeGB, 'number');
  assert.ok(freeGB > 0, `esperaba > 0 GB libres, dio ${freeGB}`);
});

test('checkDiskSpace: con un mínimo de 0 GB, nunca hay problema', () => {
  assert.equal(checkDiskSpace({ minFreeGB: 0 }), null);
});

test('checkDiskSpace: con un mínimo absurdamente alto, siempre reporta el problema', () => {
  const problem = checkDiskSpace({ minFreeGB: 999999999 });
  assert.match(problem, /Poco espacio en disco/);
  assert.match(problem, /999999999/);
});
