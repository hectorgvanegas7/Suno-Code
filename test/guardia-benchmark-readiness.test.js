// test/guardia-benchmark-readiness.test.js — Suite de regresión para
// computeFactGateReadiness (guardia-benchmark.js), extraída el 2026-07-15
// para que watchdog.js la reuse en el digest de las 7am sin que nadie tenga
// que acordarse de correr `node guardia-benchmark.js --readiness` a mano.
//
// Usa fixtures TEMPORALES propias (golden/logs falsos en una carpeta scratch)
// — nunca toca golden/ ni logs/ reales del repo. 100% offline.
// Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { computeFactGateReadiness } = require('../guardia-benchmark');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ce-readiness-'));
}

function writeGoldenCase(goldenDir, name, letraEsBuena) {
  const dir = path.join(goldenDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'expect.json'), JSON.stringify({ letraEsBuena }), 'utf-8');
}

function writeJsonl(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

test('computeFactGateReadiness: sin nada en disco, NOT READY (paths que no existen no lanzan)', () => {
  const tmp = makeTempDir();
  const result = computeFactGateReadiness({
    goldenDir: path.join(tmp, 'golden'),
    feedbackPath: path.join(tmp, 'logs', 'guardia-feedback.jsonl'),
    verdictsPath: path.join(tmp, 'logs', 'fact-verdicts.jsonl'),
  });
  assert.equal(result.ready, false);
  assert.equal(result.conditions.length, 4);
  // El banco dorado y la producción SIEMPRE fallan sin datos — "0 falsos
  // positivos" es trivialmente cierto sin data (no es lo que gatea acá).
  assert.equal(result.conditions.find((c) => c.key === 'golden').ok, false);
  assert.equal(result.conditions.find((c) => c.key === 'produccion').ok, false);
});

test('computeFactGateReadiness: READY cuando las 4 condiciones se cumplen', () => {
  const tmp = makeTempDir();
  const goldenDir = path.join(tmp, 'golden');
  for (let i = 0; i < 5; i++) writeGoldenCase(goldenDir, `mala-${i}`, false);
  for (let i = 0; i < 5; i++) writeGoldenCase(goldenDir, `buena-${i}`, true);

  const feedbackPath = path.join(tmp, 'logs', 'guardia-feedback.jsonl');
  const feedbackEntries = Array.from({ length: 14 }, (_, i) => ({ songId: `s${i}`, hechosSinRespaldo: { sinRespaldo: [] } }));
  // Una canción con una alarma real, pero CON veredicto tp (no cuenta como sin juzgar).
  feedbackEntries.push({ songId: 's15', hechosSinRespaldo: { sinRespaldo: [{ tipo: 'lugar', valor: 'X' }] } });
  writeJsonl(feedbackPath, feedbackEntries);

  const verdictsPath = path.join(tmp, 'logs', 'fact-verdicts.jsonl');
  writeJsonl(verdictsPath, [{ songId: 's15', verdict: 'tp' }]);

  const result = computeFactGateReadiness({ goldenDir, feedbackPath, verdictsPath });
  assert.equal(result.ready, true, JSON.stringify(result.conditions, null, 2));
});

test('computeFactGateReadiness: UN solo falso positivo confirmado tumba el ready aunque el resto esté perfecto', () => {
  const tmp = makeTempDir();
  const goldenDir = path.join(tmp, 'golden');
  for (let i = 0; i < 4; i++) writeGoldenCase(goldenDir, `mala-${i}`, false);
  for (let i = 0; i < 5; i++) writeGoldenCase(goldenDir, `buena-${i}`, true);

  const feedbackPath = path.join(tmp, 'logs', 'guardia-feedback.jsonl');
  writeJsonl(feedbackPath, Array.from({ length: 15 }, (_, i) => ({ songId: `s${i}`, hechosSinRespaldo: { sinRespaldo: [] } })));

  const verdictsPath = path.join(tmp, 'logs', 'fact-verdicts.jsonl');
  writeJsonl(verdictsPath, [{ songId: 's0', verdict: 'fp' }]);

  const result = computeFactGateReadiness({ goldenDir, feedbackPath, verdictsPath });
  assert.equal(result.ready, false);
  const fpCondition = result.conditions.find((c) => c.key === 'falsos-positivos');
  assert.equal(fpCondition.ok, false);
});

test('computeFactGateReadiness: una alarma SIN veredicto humano no cuenta como limpia, aunque no haya FP', () => {
  const tmp = makeTempDir();
  const goldenDir = path.join(tmp, 'golden');
  for (let i = 0; i < 4; i++) writeGoldenCase(goldenDir, `mala-${i}`, false);
  for (let i = 0; i < 5; i++) writeGoldenCase(goldenDir, `buena-${i}`, true);

  const feedbackPath = path.join(tmp, 'logs', 'guardia-feedback.jsonl');
  const entries = Array.from({ length: 14 }, (_, i) => ({ songId: `s${i}`, hechosSinRespaldo: { sinRespaldo: [] } }));
  entries.push({ songId: 's14', hechosSinRespaldo: { sinRespaldo: [{ tipo: 'lugar', valor: 'X' }] } }); // sin veredicto
  writeJsonl(feedbackPath, entries);
  writeJsonl(path.join(tmp, 'logs', 'fact-verdicts.jsonl'), []);

  const result = computeFactGateReadiness({ goldenDir, feedbackPath, verdictsPath: path.join(tmp, 'logs', 'fact-verdicts.jsonl') });
  assert.equal(result.ready, false);
  const alarmCondition = result.conditions.find((c) => c.key === 'alarmas-sin-juzgar');
  assert.equal(alarmCondition.ok, false);
});

test('computeFactGateReadiness: JSONL con líneas corruptas no lanza, solo las ignora', () => {
  const tmp = makeTempDir();
  const feedbackPath = path.join(tmp, 'logs', 'guardia-feedback.jsonl');
  fs.mkdirSync(path.dirname(feedbackPath), { recursive: true });
  fs.writeFileSync(feedbackPath, '{ esto no es JSON\n{"songId":"s1","hechosSinRespaldo":{"sinRespaldo":[]}}\n', 'utf-8');
  assert.doesNotThrow(() => computeFactGateReadiness({ goldenDir: path.join(tmp, 'golden'), feedbackPath, verdictsPath: path.join(tmp, 'nope.jsonl') }));
});

test('requerir guardia-benchmark.js NO dispara el CLI (nada de golden/ ni process.exit) — solo expone computeFactGateReadiness', () => {
  // Si el require.main guard faltara, este mismo require ya habría intentado
  // leer golden/ real y podría haber llamado process.exit — el hecho de que
  // este test llegue hasta acá y pueda seguir corriendo lo confirma.
  assert.equal(typeof computeFactGateReadiness, 'function');
});
