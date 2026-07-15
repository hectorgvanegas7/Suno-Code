// test/idempotency-inventory.test.js — INVENTARIO de acciones irreversibles
// (auditoría 2026-07-14). Cada acción del pipeline que gasta plata, publica o
// escribe en un sistema externo DEBE tener un guard contra ejecutarse dos
// veces (doble-run, watchdog kill + --resume). Este test-tabla documenta el
// inventario completo y verifica que cada guard siga existiendo en el código
// fuente — si alguien borra un guard (o agrega una acción irreversible sin
// registrarla acá), la suite rompe con el nombre exacto de lo que falta.
//
// Chequeos textuales a propósito: no prueban el COMPORTAMIENTO (eso lo hacen
// los tests de las funciones puras: decideCreateRetry, shouldAutoSubmit,
// interpretResume) — prueban que la PIEZA no desapareció en un refactor.
// 100% offline. Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf-8');

// { acción, archivo, guard: [regexes que deben existir], porQué }
const INVENTORY = [
  {
    accion: 'Create de Suno (gasta créditos reales)',
    archivo: 'lib/suno-create-dl.js',
    guards: [
      /recordIntent\('create'/,          // write-ahead ANTES del click
      /function decideCreateRetry/,      // decisión pura: jamás re-click automático
    ],
  },
  {
    accion: 'Retry de Create en el orquestador',
    archivo: 'start-flow.js',
    guards: [
      /decideCreateRetry/,               // el loop decide con la función pura
      /downloadOnly/,                    // el reintento post-click NO re-crea
    ],
  },
  {
    accion: 'Submit to QA (irreversible ante el cliente)',
    archivo: 'start-flow.js',
    guards: [
      /recordIntent\('submit'/,          // write-ahead ANTES del click
      /shouldAutoSubmit/,                // gate puro: doble submit + upload verificado
      /resumeAfterSubmitIntent/,         // resume verifica en el Flow, jamás re-submit ciego
    ],
  },
  {
    accion: 'Upload del MP3 al Flow (pisa lo que haya)',
    archivo: 'upload-to-flow.js',
    guards: [
      /recordIntent\('upload'/,          // verifiedAt SOLO tras ver el archivo en el DOM
      /previousAudioSrc/,                // distingue subida nueva de audio viejo de un REDO
      /downloads\?\.\[/,                 // sube el archivo EXACTO registrado en state
    ],
  },
  {
    accion: 'Notas del Flow (se apendean, visibles para QC)',
    archivo: 'flow-submit.js',
    guards: [
      /existingNotes\.includes\(flowNotes\)/, // no re-apendea la misma nota
    ],
  },
  {
    accion: 'Registro en la hoja (Sheets)',
    archivo: 'lib/sheets-core.js',
    guards: [
      /reason: 'duplicate'/,             // detección de fila duplicada
    ],
  },
  {
    accion: 'Post del screenshot a la galería',
    archivo: 'start-flow.js',
    guards: [
      /galleryAttempt/,                  // no re-postea si ya se mandó para este songId
    ],
  },
];

for (const item of INVENTORY) {
  test(`inventario de idempotencia: "${item.accion}" conserva su(s) guard(s) en ${item.archivo}`, () => {
    const source = read(item.archivo);
    for (const guard of item.guards) {
      assert.ok(
        guard.test(source),
        `${item.archivo} ya no contiene el guard ${guard} — la acción irreversible "${item.accion}" ` +
        'quedó sin protección contra doble ejecución. Ver LESSONS.md 2026-07-14 (intents write-ahead) antes de tocar esto.'
      );
    }
  });
}

test('inventario de idempotencia: el orden write-ahead se mantiene (intent ANTES del click de Create)', () => {
  const source = read('lib/suno-create-dl.js');
  const intentIdx = source.indexOf("recordIntent('create'");
  const clickIdx = source.indexOf("console.log('  Click en Create...')");
  assert.ok(intentIdx > -1 && clickIdx > -1, 'no se encontraron el intent o el click de Create');
  assert.ok(intentIdx < clickIdx, 'el intent de create se escribe DESPUÉS del click — el write-ahead perdió su razón de ser (un crash entre el click y el registro vuelve a ser invisible)');
});

test('inventario de idempotencia: el orden write-ahead se mantiene (intent ANTES del click de Submit)', () => {
  const source = read('start-flow.js');
  const intentIdx = source.indexOf("state.recordIntent('submit'");
  const clickIdx = source.indexOf('await submitBtn.click');
  assert.ok(intentIdx > -1 && clickIdx > -1, 'no se encontraron el intent o el click de Submit');
  assert.ok(intentIdx < clickIdx, 'el intent de submit se escribe DESPUÉS del click — un kill entre medio vuelve a permitir el doble Submit');
});
