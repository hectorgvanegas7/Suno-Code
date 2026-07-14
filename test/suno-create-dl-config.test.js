// test/suno-create-dl-config.test.js — Guarda de regresión para los timeouts
// de lib/suno-create-dl.js.
//
// Motivo (2026-07-03, ver LESSONS.md "Descarga de MP3 rota en vivo"): una
// edición externa a este repo bajó DOWNLOAD_WAIT_TIMEOUT_MS de 8 min a 3 min
// sin que nada lo detectara — la descarga real de Suno tardó más que eso y el
// pipeline la dio por perdida en vivo. Este test no puede probar el flujo de
// descarga en sí (necesita Chrome/Suno real), pero SÍ puede fallar fuerte si
// alguien vuelve a acortar el timeout por debajo de un piso razonable. 100%
// offline — solo importa las constantes, no ejecuta nada de Playwright.
// Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { DOWNLOAD_WAIT_TIMEOUT_MS, GENERATION_TIMEOUT_MS, decideCreateRetry } = require('../lib/suno-create-dl');

test('DOWNLOAD_WAIT_TIMEOUT_MS no baja del piso de 5 minutos', () => {
  assert.ok(
    DOWNLOAD_WAIT_TIMEOUT_MS >= 5 * 60 * 1000,
    `DOWNLOAD_WAIT_TIMEOUT_MS es ${DOWNLOAD_WAIT_TIMEOUT_MS}ms — el incidente de 2026-07-03 ` +
    'fue justo por bajarlo a 3 min; una descarga real de Suno puede tardar más que eso.'
  );
});

test('GENERATION_TIMEOUT_MS no baja del piso de 8 minutos', () => {
  assert.ok(
    GENERATION_TIMEOUT_MS >= 8 * 60 * 1000,
    `GENERATION_TIMEOUT_MS es ${GENERATION_TIMEOUT_MS}ms — por debajo de 8 min es más corto ` +
    'que el valor de diseño original (ver LESSONS.md, 2026-07-01).'
  );
});

// ─── decideCreateRetry: la regla firme de Hector (2026-07-14) ─────────────────
// NUNCA re-clickear Create automáticamente si ya se clickeó una vez.

test('decideCreateRetry: NUNCA re-clickea Create automáticamente si ya se clickeó', () => {
  // Recorre todos los intentos posibles: con clickedAt presente, JAMÁS puede
  // salir 'retry-create' — esa es la regla inquebrantable completa.
  for (let attempt = 1; attempt <= 10; attempt++) {
    const decision = decideCreateRetry({ clickedAt: '2026-07-14T03:00:00Z', attempt, maxAttempts: 3 });
    assert.notEqual(
      decision,
      'retry-create',
      `Con clickedAt presente y attempt=${attempt}, decideCreateRetry devolvió 'retry-create' — ` +
      'eso re-clickearía Create y gastaría créditos de Suno sin confirmación humana (regla firme de Hector).'
    );
  }
});

test('decideCreateRetry: clickedAt presente y quedan intentos → solo reintenta la descarga', () => {
  assert.equal(decideCreateRetry({ clickedAt: 't', attempt: 1, maxAttempts: 3 }), 'retry-download-only');
  assert.equal(decideCreateRetry({ clickedAt: 't', attempt: 2, maxAttempts: 3 }), 'retry-download-only');
});

test('decideCreateRetry: fallo pre-click (sin clickedAt) puede reintentar Create — no se gastó nada', () => {
  assert.equal(decideCreateRetry({ clickedAt: null, attempt: 1, maxAttempts: 3 }), 'retry-create');
  assert.equal(decideCreateRetry({ clickedAt: undefined, attempt: 2, maxAttempts: 3 }), 'retry-create');
});

test('decideCreateRetry: intentos agotados → give-up (pausa/aviso, nunca acción automática)', () => {
  assert.equal(decideCreateRetry({ clickedAt: null, attempt: 3, maxAttempts: 3 }), 'give-up');
  assert.equal(decideCreateRetry({ clickedAt: 't', attempt: 3, maxAttempts: 3 }), 'give-up');
  assert.equal(decideCreateRetry({ clickedAt: 't', attempt: 7, maxAttempts: 3 }), 'give-up');
});

test('lib/suno-create-dl.js no reintrodujo la descarga por interceptación de red', () => {
  // Guarda textual, no solo de comportamiento: el bug real (LESSONS.md,
  // 2026-07-03) era que el bypass de red compartía el watcher/timeout con el
  // flujo visual y lo dejaba sin ventana real. Si alguien lo reintroduce, este
  // test lo marca de inmediato en vez de esperar a que falle en vivo de nuevo.
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'suno-create-dl.js'), 'utf-8');
  assert.ok(
    !source.includes('interceptedAudioUrls') && !source.includes("page.on('response'"),
    'Se detectó de nuevo el mecanismo de "Bypass de Red" — ver LESSONS.md (2026-07-03) antes de reintroducirlo.'
  );
});
