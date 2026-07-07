// Tests de atomicWriteJson (lib/pipeline-state.js): la escritura de state.json
// es tmp + rename para que un crash a mitad de write nunca deje un JSON
// truncado (un state corrupto apaga en silencio la salvaguarda anti-Create-
// duplicado de start-flow.js). Igual que el resto de la suite, NUNCA toca el
// state.json real — todo contra una carpeta temporal propia.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { atomicWriteJson } = require('../lib/pipeline-state');

test('atomicWriteJson: escribe JSON válido y legible', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-state-test-'));
  const target = path.join(dir, 'state.json');
  try {
    atomicWriteJson(target, { songId: 'PS0180', stage: 'generated' });
    const parsed = JSON.parse(fs.readFileSync(target, 'utf-8'));
    assert.deepStrictEqual(parsed, { songId: 'PS0180', stage: 'generated' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atomicWriteJson: no deja el archivo temporal .tmp atrás', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-state-test-'));
  const target = path.join(dir, 'state.json');
  try {
    atomicWriteJson(target, { a: 1 });
    assert.ok(!fs.existsSync(`${target}.tmp`), 'el .tmp debería haberse renombrado');
    assert.deepStrictEqual(fs.readdirSync(dir), ['state.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atomicWriteJson: sobreescribir un estado existente lo reemplaza completo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-state-test-'));
  const target = path.join(dir, 'state.json');
  try {
    atomicWriteJson(target, { songId: 'PS0180', titulo: 'Vieja' });
    atomicWriteJson(target, { songId: 'PS0181' });
    const parsed = JSON.parse(fs.readFileSync(target, 'utf-8'));
    assert.deepStrictEqual(parsed, { songId: 'PS0181' }, 'el merge lo hace write(), no atomicWriteJson');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
