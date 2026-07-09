// test/llm-provider.test.js — Suite de regresión local para lib/llm-provider.js.
//
// 100% offline: nunca llama a ninguna API. Cubre el bug real detectado
// 2026-07-08: QA_CHECKLIST_KEYS (usada para forzar el JSON schema de la
// respuesta de la API) es una copia a mano del bloque qaChecklist literal
// del SYSTEM_PROMPT en run.js, y quedó desincronizada en silencio (20 claves
// en el schema contra 32 reales en el prompt) — cualquier clave nueva del
// checklist que el prompt le pida al modelo pero no esté en el schema queda
// forzada fuera de la respuesta real por `additionalProperties: false`.
// Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { QA_CHECKLIST_KEYS, buildSongJsonSchema } = require('../lib/llm-provider');

// Extrae las claves del bloque "qaChecklist": { ... } literal del
// SYSTEM_PROMPT en run.js, en el mismo orden en que aparecen — sin ejecutar
// run.js (que abriría Chrome/leería survey.txt), solo lee el archivo como texto.
function extractQaChecklistKeysFromRunJs() {
  const content = fs.readFileSync(path.join(__dirname, '..', 'run.js'), 'utf-8');
  const blockMatch = content.match(/"qaChecklist":\s*\{([\s\S]*?)\n {2}\},/);
  if (!blockMatch) throw new Error('No se encontró el bloque "qaChecklist": { ... } en run.js — ¿cambió el formato del RESPONSE FORMAT?');
  return [...blockMatch[1].matchAll(/"([a-z0-9_]+)":\s*true/g)].map((m) => m[1]);
}

test('QA_CHECKLIST_KEYS (lib/llm-provider.js) coincide EXACTAMENTE con el bloque qaChecklist real de run.js', () => {
  const realKeys = extractQaChecklistKeysFromRunJs();
  assert.ok(realKeys.length > 0, 'no se pudo extraer ninguna clave del bloque qaChecklist de run.js — revisar la regex');

  const missingFromSchema = realKeys.filter((k) => !QA_CHECKLIST_KEYS.includes(k));
  const extraInSchema = QA_CHECKLIST_KEYS.filter((k) => !realKeys.includes(k));

  assert.deepEqual(
    missingFromSchema,
    [],
    `El SYSTEM_PROMPT de run.js le pide al modelo autoevaluar estas claves, pero QA_CHECKLIST_KEYS no las incluye — quedan forzadas fuera de la respuesta real por additionalProperties:false: ${missingFromSchema.join(', ')}`
  );
  assert.deepEqual(
    extraInSchema,
    [],
    `QA_CHECKLIST_KEYS tiene claves que ya no existen en el SYSTEM_PROMPT de run.js (limpieza pendiente): ${extraInSchema.join(', ')}`
  );
});

test('buildSongJsonSchema: qaChecklist.required incluye TODAS las QA_CHECKLIST_KEYS', () => {
  const schema = buildSongJsonSchema();
  assert.deepEqual(schema.properties.qaChecklist.required, QA_CHECKLIST_KEYS);
  assert.deepEqual(Object.keys(schema.properties.qaChecklist.properties), QA_CHECKLIST_KEYS);
});
