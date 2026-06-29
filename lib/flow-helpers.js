// lib/flow-helpers.js — Lógica COMPARTIDA para entrar al Artist Flow y asegurar
// que haya una asignación activa cargada (#lyrics presente).
//
// Antes esta lógica estaba duplicada y divergente: run.js la tenía completa
// (Enter Flow -> esperar -> chequear #lyrics -> si no, Assign Most Urgent Song)
// pero start-flow.js tenía una versión incompleta que se rendía sin clickear
// "Assign Most Urgent Song" — esa era la causa raíz del fallo del Paso 4/4
// ("No se encontró #lyrics..."). Ahora ambos importan ESTA función, así que
// nunca más pueden divergir.
//
// Ver LESSONS.md:
//  - "Assign Most Urgent Song — click target vanishes mid-click": por qué hay
//    que esperar a que la página se asiente y chequear #lyrics (señal concreta)
//    en vez de la ausencia del botón Assign.
//  - "Flaky page-transition retries": por qué reintentamos con backoff antes
//    de declarar un fallo real.

const FLOW_URL = 'https://cancioneterna.com/artists/flow';

// Espera hasta que #lyrics esté presente, con reintentos. Devuelve true si
// apareció, false si se agotaron los intentos.
async function waitForLyrics(page, { tries = 6, intervalMs = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    if ((await page.locator('#lyrics').count()) > 0) return true;
    await page.waitForTimeout(intervalMs);
  }
  return (await page.locator('#lyrics').count()) > 0;
}

// Dada una page ya ubicada en (o que se llevará a) el Flow, hace lo necesario
// para terminar con una asignación activa cargada:
//   1. Si #lyrics ya está, no hace nada (asignación ya activa).
//   2. Si hay botón "Enter Flow", lo clickea.
//   3. Espera a que la página se asiente y reaparezca #lyrics.
//   4. Si sigue sin #lyrics, clickea "Assign Most Urgent Song" y vuelve a esperar.
// Tira un Error descriptivo (indicando en qué sub-paso murió) si no lo logra.
//
// `clickByText` se pasa como parámetro para no crear una dependencia circular
// entre los helpers — start-flow.js y run.js ya lo importan de playwright-helpers.
async function enterFlowAndEnsureAssignment(page, clickByText, { navigate = false } = {}) {
  if (navigate) {
    await page.goto(FLOW_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
  }

  // 1. ¿Ya hay asignación activa?
  if ((await page.locator('#lyrics').count()) > 0) {
    return { entered: true, assigned: 'already-active' };
  }

  // 2. Enter Flow (si está disponible)
  const enterFlowBtn = page.getByText('Enter Flow', { exact: false });
  if ((await enterFlowBtn.count()) > 0) {
    await clickByText(page, 'Enter Flow');
    await page.waitForLoadState('networkidle').catch(() => {});
    // El cliente tarda un instante en confirmar si ya hay una asignación activa
    // (a veces muestra "Assign Most Urgent Song" brevemente antes de
    // reemplazarlo por la asignación existente). Esperamos a que se asiente.
    await waitForLyrics(page, { tries: 3, intervalMs: 800 });
  }

  // 3. ¿Apareció #lyrics tras Enter Flow?
  if ((await page.locator('#lyrics').count()) > 0) {
    return { entered: true, assigned: 'active-after-enter' };
  }

  // 4. No hay asignación activa — asignar la más urgente.
  const assignBtn = page.getByText('Assign Most Urgent Song', { exact: false });
  if ((await assignBtn.count()) > 0) {
    await clickByText(page, 'Assign Most Urgent Song');
    await page.waitForLoadState('networkidle').catch(() => {});
    const ok = await waitForLyrics(page, { tries: 6, intervalMs: 1000 });
    if (ok) return { entered: true, assigned: 'newly-assigned' };
    const noSongErr = new Error(
      'Se clickeó "Assign Most Urgent Song" pero #lyrics nunca apareció. ' +
        '¿La asignación no terminó de cargar, o no había canciones en cola?'
    );
    noSongErr.noSong = true;
    throw noSongErr;
  }

  // Ni #lyrics, ni botón Enter Flow utilizable, ni botón Assign.
  throw new Error(
    'No se encontró #lyrics, ni "Enter Flow", ni "Assign Most Urgent Song" en el Flow. ' +
      '¿La sesión está logueada y la página cargó bien? URL actual: ' +
      page.url()
  );
}

module.exports = { FLOW_URL, waitForLyrics, enterFlowAndEnsureAssignment };
