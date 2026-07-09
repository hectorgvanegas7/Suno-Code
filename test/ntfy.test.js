// test/ntfy.test.js — Regresión del bug real de notificaciones (2026-07-09):
// la versión anterior mandaba el título como header HTTP y fetch() de Node
// exige headers ByteString (Latin-1) — cualquier título con emoji tiraba
// TypeError antes de tocar la red y la notificación jamás llegaba (justo las
// críticas: watchdog 🛑/🔄, timeout humano ⏱️, digest 🌙). Ahora el título va
// en el body JSON (UTF-8 completo). Estos tests fijan ese contrato sin red.

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildNtfyPayload, PRIORITY_MAP, TOPIC } = require('../lib/ntfy');

test('buildNtfyPayload: un título con emoji sobrevive intacto en el body (el bug que silenciaba las notificaciones críticas)', () => {
  const payload = buildNtfyPayload('cuerpo', { title: '🛑 Watchdog: circuit breaker' });
  assert.equal(payload.title, '🛑 Watchdog: circuit breaker');
  assert.equal(payload.topic, TOPIC);
  // El payload entero tiene que ser serializable a JSON sin perder el emoji.
  assert.match(JSON.stringify(payload), /🛑/);
});

test('buildNtfyPayload: prioridades se mapean a los enteros 1-5 de la API JSON de ntfy', () => {
  assert.equal(buildNtfyPayload('x', { priority: 'urgent' }).priority, 5);
  assert.equal(buildNtfyPayload('x', { priority: 'high' }).priority, 4);
  assert.equal(buildNtfyPayload('x', { priority: 'default' }).priority, 3);
  assert.equal(buildNtfyPayload('x', { priority: 'low' }).priority, 2);
  assert.equal(buildNtfyPayload('x', { priority: 'min' }).priority, 1);
  // Prioridad desconocida cae a default en vez de romper el envío.
  assert.equal(buildNtfyPayload('x', { priority: 'lo-que-sea' }).priority, PRIORITY_MAP.default);
});

test('buildNtfyPayload: tags en string separado por comas se convierte en array limpio', () => {
  assert.deepEqual(buildNtfyPayload('x', { tags: 'zzz,warning' }).tags, ['zzz', 'warning']);
  assert.deepEqual(buildNtfyPayload('x', { tags: ' a , b ,' }).tags, ['a', 'b']);
});

test('buildNtfyPayload: defaults completos sin opciones', () => {
  const payload = buildNtfyPayload('hola');
  assert.equal(payload.message, 'hola');
  assert.equal(payload.title, 'Canción Eterna');
  assert.equal(payload.priority, 3);
  assert.deepEqual(payload.tags, ['musical_note']);
  assert.equal(payload.click, undefined);
});
