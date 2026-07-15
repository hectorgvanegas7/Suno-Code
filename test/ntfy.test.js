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

// ─── Canal de respuestas remoto (2026-07-14) — todo offline ──────────────────

const { parseReply, buildReplyActionsPayload, waitForNtfyReply, REPLY_TOPIC } = require('../lib/ntfy');

test('parseReply: matchea solo el requestId vigente con verbo conocido', () => {
  assert.equal(parseReply('a1b2c3d4:ok', 'a1b2c3d4'), 'ok');
  assert.equal(parseReply('a1b2c3d4:abort', 'a1b2c3d4'), 'abort');
  assert.equal(parseReply('  a1b2c3d4:ok \n', 'a1b2c3d4'), 'ok'); // espacios tolerados
});

test('parseReply: ignora requestId ajeno, verbos desconocidos y basura (replay/mensaje ajeno no destraba nada)', () => {
  assert.equal(parseReply('deadbeef:ok', 'a1b2c3d4'), null);       // nonce viejo/ajeno
  assert.equal(parseReply('a1b2c3d4:continue', 'a1b2c3d4'), null); // verbo desconocido
  assert.equal(parseReply('hola', 'a1b2c3d4'), null);
  assert.equal(parseReply('', 'a1b2c3d4'), null);
  assert.equal(parseReply(null, 'a1b2c3d4'), null);
  assert.equal(parseReply('a1b2c3d4:ok:extra', 'a1b2c3d4'), null); // formato roto
});

test('buildReplyActionsPayload: botones HTTP que postean <requestId>:<verbo> al tópico de respuestas', () => {
  const p = buildReplyActionsPayload('¿continuar?', { requestId: 'a1b2c3d4', title: 'Test', priority: 'high' });
  assert.equal(p.actions.length, 2);
  for (const a of p.actions) {
    assert.equal(a.action, 'http');
    assert.equal(a.method, 'POST');
    assert.equal(a.url, `https://ntfy.sh/${REPLY_TOPIC}`);
    assert.equal(a.clear, true);
  }
  assert.equal(p.actions[0].body, 'a1b2c3d4:ok');
  assert.equal(p.actions[1].body, 'a1b2c3d4:abort');
  // Hereda el payload base intacto (título, prioridad numérica).
  assert.equal(p.title, 'Test');
  assert.equal(p.priority, 4);
});

test('buildReplyActionsPayload: verbs custom cambian etiquetas y cuerpos', () => {
  const p = buildReplyActionsPayload('x', {
    requestId: 'ffff0000',
    verbs: [{ verb: 'ok', label: '✅ Re-Create (gasta créditos)' }],
  });
  assert.equal(p.actions.length, 1);
  assert.equal(p.actions[0].body, 'ffff0000:ok');
  assert.match(p.actions[0].label, /Re-Create/);
});

test('waitForNtfyReply: encuentra la respuesta correcta en el NDJSON del poll (ignorando ruido)', async () => {
  const ndjson = [
    JSON.stringify({ event: 'open' }),
    JSON.stringify({ event: 'message', message: 'otro-nonce:ok' }),
    JSON.stringify({ event: 'message', message: 'a1b2c3d4:abort' }),
  ].join('\n');
  const verb = await waitForNtfyReply({
    requestId: 'a1b2c3d4',
    timeoutMs: 5000,
    pollIntervalMs: 1,
    fetchImpl: async () => ({ ok: true, text: async () => ndjson }),
  });
  assert.equal(verb, 'abort');
});

test('waitForNtfyReply: sin respuesta llega al deadline y devuelve null (nunca lanza)', async () => {
  const verb = await waitForNtfyReply({
    requestId: 'a1b2c3d4',
    timeoutMs: 30,
    pollIntervalMs: 5,
    fetchImpl: async () => ({ ok: true, text: async () => '' }),
  });
  assert.equal(verb, null);
});

test('waitForNtfyReply: red caída (fetch lanza) no rompe — sigue reintentando hasta el deadline', async () => {
  let calls = 0;
  const verb = await waitForNtfyReply({
    requestId: 'a1b2c3d4',
    timeoutMs: 40,
    pollIntervalMs: 5,
    fetchImpl: async () => { calls++; throw new Error('ECONNRESET'); },
  });
  assert.equal(verb, null);
  assert.ok(calls >= 2, `esperaba al menos 2 reintentos, hubo ${calls}`);
});

test('waitForNtfyReply: abortSignal corta el poll de inmediato', async () => {
  const ctl = new AbortController();
  ctl.abort();
  const verb = await waitForNtfyReply({
    requestId: 'a1b2c3d4',
    timeoutMs: 60000,
    fetchImpl: async () => { throw new Error('no debería llamarse'); },
    abortSignal: ctl.signal,
  });
  assert.equal(verb, null);
});
