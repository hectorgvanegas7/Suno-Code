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
//  - "enterFlowAndEnsureAssignment: falla si React no renderizó aún": por qué
//    usamos waitForFunction de 30s en vez de .count() inmediato.

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
//   2. Espera con waitForFunction (30s) a que React renderice cualquiera de los
//      estados posibles: #lyrics, "Enter Flow", "Assign Most Urgent Song", o login.
//      Si ninguno aparece en 30s, tira error descriptivo.
//   3. Si el estado es login (URL o formulario), error claro "sesión no logueada".
//   4. Si hay botón "Enter Flow", lo clickea y espera a que aparezca la asignación.
//   5. Si sigue sin #lyrics, clickea "Assign Most Urgent Song" y vuelve a esperar.
// Tira un Error descriptivo (indicando en qué sub-paso murió) si no lo logra.
//
// `clickByText` se pasa como parámetro para no crear una dependencia circular
// entre los helpers — start-flow.js y run.js ya lo importan de playwright-helpers.
async function enterFlowAndEnsureAssignment(page, clickByText, { navigate = false } = {}) {
  if (navigate) {
    await page.goto(FLOW_URL, { waitUntil: 'domcontentloaded' });
  }

  // Detectar login inmediato por URL antes de esperar elementos.
  if (/\/(sign-in|login)/.test(page.url())) {
    throw new Error(
      'Sesión no logueada en el Flow. La página redirigió a la pantalla de login. ' +
      'Logueate manualmente en el Chrome del puerto de debug y volvé a correr. ' +
      'URL actual: ' + page.url()
    );
  }

  // Esperar a que React renderice cualquiera de los estados posibles.
  // No asumir que los elementos ya están en el DOM — el contenido carga async.
  // La función devuelve una cadena que identifica qué estado ganó el race.
  let state;
  try {
    const handle = await page.waitForFunction(
      () => {
        if (document.querySelector('#lyrics')) return 'lyrics';
        const els = Array.from(document.querySelectorAll('a, button'));
        if (els.some((el) => /enter flow/i.test(el.textContent.trim()))) return 'enter-flow';
        if (els.some((el) => /assign most urgent song/i.test(el.textContent.trim()))) return 'assign';
        if (document.querySelector('input[type="email"], input[type="password"]')) return 'login';
        return null;
      },
      { timeout: 30000 }
    );
    state = await handle.jsonValue();
  } catch {
    throw new Error(
      'El Flow no mostró ningún estado reconocible en 30s. ' +
      '¿La sesión está logueada y la página cargó bien? URL actual: ' + page.url()
    );
  }

  // Login detectado por formulario en el DOM.
  if (state === 'login') {
    throw new Error(
      'Sesión no logueada en el Flow. Se detectó formulario de login en la página. ' +
      'Logueate manualmente en el Chrome del puerto de debug y volvé a correr. ' +
      'URL actual: ' + page.url()
    );
  }

  // Asignación ya activa.
  if (state === 'lyrics') {
    return { entered: true, assigned: 'already-active' };
  }

  // Entrar al Flow si el botón está disponible.
  if (state === 'enter-flow') {
    await clickByText(page, 'Enter Flow');
    // El cliente tarda un instante en confirmar si ya hay una asignación activa
    // (a veces muestra "Assign Most Urgent Song" brevemente antes de
    // reemplazarlo por la asignación existente). Esperamos a que se asiente.
    await waitForLyrics(page, { tries: 3, intervalMs: 800 });
  }

  // ¿Apareció #lyrics (ya sea directo o tras Enter Flow)?
  if ((await page.locator('#lyrics').count()) > 0) {
    return { entered: true, assigned: state === 'enter-flow' ? 'active-after-enter' : 'already-active' };
  }

  // No hay asignación activa — asignar la más urgente.
  const assignBtn = page.getByText('Assign Most Urgent Song', { exact: false });
  if ((await assignBtn.count()) > 0) {
    await clickByText(page, 'Assign Most Urgent Song');
    const ok = await waitForLyrics(page, { tries: 6, intervalMs: 1000 });
    if (ok) return { entered: true, assigned: 'newly-assigned' };
    const noSongErr = new Error(
      'Se clickeó "Assign Most Urgent Song" pero #lyrics nunca apareció. ' +
        '¿La asignación no terminó de cargar, o no había canciones en cola?'
    );
    noSongErr.noSong = true;
    throw noSongErr;
  }

  throw new Error(
    'No se encontró #lyrics ni "Assign Most Urgent Song" tras "Enter Flow". ' +
    '¿La sesión está logueada? URL actual: ' + page.url()
  );
}

module.exports = { FLOW_URL, waitForLyrics, enterFlowAndEnsureAssignment };
