// test/preflight.test.js — Suite de regresión local para la parte de disco
// de lib/preflight.js (checkDiskSpace/getFreeDiskGB). El resto de
// runPreflight depende de credenciales/env reales del proyecto y no se
// testea acá. 100% offline. Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkDiskSpace, getFreeDiskGB, checkCdpPort, checkLanguageTool } = require('../lib/preflight');

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

// ─── checkCdpPort (fetch/connect inyectados — offline) ───────────────────────

test('checkCdpPort: Chrome debug respondiendo /json/version → sin problema', async () => {
  const result = await checkCdpPort(9333, {
    fetchImpl: async () => ({ ok: true }),
    connectImpl: async () => { throw new Error('no debería chequear TCP si el debug responde'); },
  });
  assert.equal(result, null);
});

test('checkCdpPort: puerto libre (fetch falla, TCP no conecta) → sin problema, start-flow lanza Chrome', async () => {
  const result = await checkCdpPort(9333, {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    connectImpl: async () => false,
  });
  assert.equal(result, null);
});

test('checkCdpPort: puerto ocupado por algo que NO es Chrome debug → problema con instrucción', async () => {
  const result = await checkCdpPort(9333, {
    fetchImpl: async () => { throw new Error('socket hang up'); },
    connectImpl: async () => true,
  });
  assert.match(result, /ocupado/);
  assert.match(result, /suno-open-for-login/);
});

test('checkCdpPort: /json/version con status no-ok cuenta como "no es Chrome debug"', async () => {
  const result = await checkCdpPort(9333, {
    fetchImpl: async () => ({ ok: false, status: 403 }),
    connectImpl: async () => true,
  });
  assert.match(result, /ocupado/);
});

// ─── checkLanguageTool (fetch inyectado — offline) ───────────────────────────

test('checkLanguageTool: servicio OK → sin advertencia', async () => {
  assert.equal(await checkLanguageTool({ fetchImpl: async () => ({ ok: true }) }), null);
});

test('checkLanguageTool: servicio caído → advertencia (no bloquea, solo avisa)', async () => {
  const warning = await checkLanguageTool({ fetchImpl: async () => { throw new Error('ETIMEDOUT'); } });
  assert.match(warning, /LanguageTool no responde/);
  assert.match(warning, /degradar/);
});

test('checkLanguageTool: respuesta no-ok → advertencia con el status', async () => {
  const warning = await checkLanguageTool({ fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.match(warning, /503/);
});
