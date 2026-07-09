// test/heartbeat.test.js — createStageHeartbeat (lib/heartbeat.js): el ticker
// por etapa que mantiene el heartbeat latiendo durante runFlow. Regresión del
// bug real (auditoría 2026-07-09): el heartbeat solo se escribía en 2 loops y
// el watchdog mataba pipelines SANOS a mitad de Create/descarga.
// 100% offline: usa un heartbeatPath en un tmp dir, nunca toca logs/ real.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeHeartbeat, readHeartbeat, clearHeartbeat, createStageHeartbeat } = require('../lib/heartbeat');

function tmpHeartbeatPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-hb-test-'));
  return path.join(dir, 'heartbeat.json');
}

test('writeHeartbeat/readHeartbeat: round-trip con ts y pid', () => {
  const p = tmpHeartbeatPath();
  writeHeartbeat({ mode: 'test' }, { heartbeatPath: p });
  const hb = readHeartbeat({ heartbeatPath: p });
  assert.equal(hb.mode, 'test');
  assert.equal(hb.pid, process.pid);
  assert.ok(!Number.isNaN(new Date(hb.ts).getTime()));
});

test('clearHeartbeat: borra el archivo (apagado intencional de --loop) y no lanza si no existe', () => {
  const p = tmpHeartbeatPath();
  writeHeartbeat({}, { heartbeatPath: p });
  clearHeartbeat({ heartbeatPath: p });
  assert.equal(readHeartbeat({ heartbeatPath: p }), null);
  clearHeartbeat({ heartbeatPath: p }); // segunda vez: no lanza
});

test('createStageHeartbeat: late al crear y al cambiar de etapa, con la etapa visible en el archivo', () => {
  const p = tmpHeartbeatPath();
  const hb = createStageHeartbeat({ heartbeatPath: p, intervalMs: 60 * 60 * 1000 });
  try {
    assert.equal(readHeartbeat({ heartbeatPath: p }).stage, 'inicio');
    hb.setStage('create-descarga', { maxMinutes: 45 });
    const after = readHeartbeat({ heartbeatPath: p });
    assert.equal(after.stage, 'create-descarga');
    assert.equal(after.stageMaxMinutes, 45);
  } finally {
    hb.stop();
  }
});

test('createStageHeartbeat: cuando la etapa excede su techo, tick() deja de latir A PROPÓSITO (hang real → el watchdog actúa)', () => {
  const p = tmpHeartbeatPath();
  const hb = createStageHeartbeat({ heartbeatPath: p, intervalMs: 60 * 60 * 1000 });
  try {
    // maxMinutes: 0 → el techo ya está excedido desde el instante cero.
    hb.setStage('etapa-colgada', { maxMinutes: 0 });
    clearHeartbeat({ heartbeatPath: p }); // limpiar lo que setStage alcanzó a escribir antes del techo
    assert.equal(hb.tick(), false, 'tick() debe devolver false con la etapa vencida');
    assert.equal(readHeartbeat({ heartbeatPath: p }), null, 'no debe escribir heartbeat con la etapa vencida');

    // Y al pasar a una etapa nueva con techo sano, vuelve a latir.
    hb.setStage('etapa-sana', { maxMinutes: 30 });
    assert.equal(hb.tick(), true);
    assert.equal(readHeartbeat({ heartbeatPath: p }).stage, 'etapa-sana');
  } finally {
    hb.stop();
  }
});
