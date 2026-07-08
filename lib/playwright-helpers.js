// Shared Playwright helpers for the Canción Eterna automation scripts
// (run.js, suno-fill.js, suno-create.js). See LESSONS.md for the bugs
// that led to some of these.

const { notify } = require('./ntfy');

// Devuelve true si un puerto local está respondiendo a una petición HTTP
// de debugging de Chromium (/json/version).
async function isPortUp(port) {
  try {
    const res = await fetch(`http://localhost:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

// Verifica que el puerto no esté en uso. Si lo está, y el proceso que lo
// ocupa es realmente Chrome, lo mata para liberar el puerto automáticamente.
// Si es cualquier otro proceso, aborta el pipeline en vez de matarlo a ciegas
// (Stop-Process por puerto puede acertarle a un proceso que no tiene nada
// que ver con Chrome).
async function ensurePortIsFree(port) {
  if (await isPortUp(port)) {
    console.log(`⚠️  Puerto ${port} bloqueado/ocupado. Verificando el proceso antes de intentar liberarlo...`);
    const { execFileSync } = require('child_process');

    // port siempre es una constante interna (nunca viene de la encuesta ni
    // de la web), pero validamos igual antes de meterlo en un -Command de
    // PowerShell — cinturón y tiradores. execFileSync (en vez de execSync)
    // ya evita la capa de parseo de cmd.exe; esto cierra la de PowerShell.
    if (!/^\d+$/.test(String(port))) {
      throw new Error(`ensurePortIsFree: puerto inválido "${port}".`);
    }

    let pid = '';
    try {
      pid = execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`],
        { encoding: 'utf-8' }
      ).trim();
    } catch {
      pid = '';
    }

    if (pid && !/^\d+$/.test(pid)) {
      pid = ''; // salida inesperada — no confiar, tratar como "no encontrado"
    }

    let procName = '';
    if (pid) {
      try {
        procName = execFileSync(
          'powershell',
          ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName`],
          { encoding: 'utf-8' }
        ).trim();
      } catch {
        procName = '';
      }
    }

    if (!/^chrome$/i.test(procName)) {
      throw new Error(
        `El puerto ${port} está bloqueado/ocupado por un proceso que no es Chrome (detectado: "${procName || 'desconocido'}", PID ${pid || '?'}).\n` +
        `Por seguridad no se mata automáticamente.\n` +
        `Asegúrate de no tener una instancia de Chrome abierta con remote debugging en ese puerto.\n` +
        `Pipeline detenido preventivamente.`
      );
    }

    console.log(`  Proceso Chrome (PID ${pid}) detectado en el puerto ${port}. Matándolo para liberar el puerto...`);
    try {
      execFileSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force`], { stdio: 'ignore' });
      console.log(`✅ Proceso Chrome en puerto ${port} matado exitosamente.`);
      await new Promise(r => setTimeout(r, 2000)); // Dar tiempo a Windows de soltar el socket TCP
      if (await isPortUp(port)) {
        throw new Error(`El puerto ${port} sigue activo después del kill.`);
      }
    } catch (e) {
      throw new Error(
        `El puerto ${port} está bloqueado/ocupado y no se pudo matar automáticamente.\n` +
        `Detalles: ${e.message}\n` +
        `Pipeline detenido preventivamente.`
      );
    }
  }
}

// Identifica qué elemento está sobre las coordenadas del center del locator.
// Devuelve un string legible para mensajes de error.
async function identifyBlocker(page, locator) {
  try {
    const box = await locator.first().boundingBox();
    if (!box) return 'botón sin posición en el DOM (no visible o fuera de pantalla)';
    const cx = Math.round(box.x + box.width / 2);
    const cy = Math.round(box.y + box.height / 2);
    const info = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return 'ningún elemento en esas coordenadas';
      const parts = [el.tagName.toLowerCase()];
      if (el.id) parts.push(`#${el.id}`);
      if (el.getAttribute('data-testid')) parts.push(`[data-testid="${el.getAttribute('data-testid')}"]`);
      if (el.getAttribute('aria-label')) parts.push(`[aria-label="${el.getAttribute('aria-label')}"]`);
      if (el.className) parts.push(`.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`);
      const txt = el.textContent?.trim().substring(0, 50);
      if (txt) parts.push(`"${txt}"`);
      return parts.join('');
    }, [cx, cy]);
    return `${info} (coordenadas ${cx},${cy})`;
  } catch (e) {
    return `error al inspeccionar DOM: ${e.message}`;
  }
}

// Devuelve true si el elemento en el centro del locator (via elementFromPoint)
// es el propio elemento (o un ancestro/descendiente de él) — es decir, nada lo
// está tapando visualmente en este instante. Complementa a identifyBlocker
// (que describe QUÉ bloquea) con una respuesta boolean simple para checks
// previos a un click real.
async function isClickable(page, locator) {
  try {
    const box = await locator.first().boundingBox();
    if (!box) return false;
    const cx = Math.round(box.x + box.width / 2);
    const cy = Math.round(box.y + box.height / 2);
    return await locator.first().evaluate((el, [x, y]) => {
      const atPoint = document.elementFromPoint(x, y);
      return !!atPoint && (atPoint === el || el.contains(atPoint) || atPoint.contains(el));
    }, [cx, cy]);
  } catch {
    return false;
  }
}

// Hace click en un locator de forma robusta:
//   1. Scroll into view.
//   2. Intenta trial: true para detectar interceptores sin clickear.
//   3. Si trial falla, identifica qué elemento está encima con elementFromPoint.
//   4. Espera waitMs para que overlays transitorios desaparezcan y reintenta.
//   5. En el último intento prueba force: true si no es un modal real.
//   6. Si sigue sin poder, lanza con el nombre exacto del bloqueador.
//
// label: nombre del botón para los logs de error.
// maxAttempts: total de intentos (default 5).
// waitMs: cuánto esperar entre intentos (se multiplica por intento).
// screenshotPrefix: si se pasa, guarda screenshots diagnósticos antes de cada click.
// allowForce: si true, el último intento usa force:true (default true para overlays transitorios).
async function safeClick(page, locator, {
  label = 'botón',
  maxAttempts = 5,
  waitMs = 600,
  screenshotPrefix = null,
  allowForce = true,
} = {}) {
  let lastBlockerInfo = 'desconocido';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await page.waitForTimeout(waitMs * attempt);

    // Asegurar que el botón esté visible y en pantalla
    await locator.first().scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(200);

    // Screenshot de diagnóstico antes de cada intento (essencial para diagnosticar el bloqueador)
    if (screenshotPrefix) {
      await page.screenshot({ path: `${screenshotPrefix}-pre-click-attempt${attempt}.png` }).catch(() => {});
    }

    // Trial click: detecta interceptores sin clickear de verdad
    const trialErr = await locator.first().click({ trial: true }).then(() => null).catch((e) => e);

    if (!trialErr) {
      // Nada bloquea — click real
      try {
        await locator.first().click();
        return; // éxito
      } catch (realErr) {
        // Raro: trial OK pero click falló (race condition). Loguear y reintentar.
        lastBlockerInfo = `race condition post-trial: ${realErr.message.split('\n')[0]}`;
        continue;
      }
    }

    // Trial falló — identificar qué está bloqueando
    lastBlockerInfo = await identifyBlocker(page, locator);
    console.log(`  [safeClick] Intento ${attempt}/${maxAttempts}: "${label}" bloqueado por → ${lastBlockerInfo}`);

    // Último intento: force: true como último recurso (solo si el bloqueador parece transitorio)
    if (attempt === maxAttempts && allowForce) {
      console.log(`  [safeClick] Último intento con force: true para "${label}"...`);
      try {
        await locator.first().click({ force: true });
        console.log(`  [safeClick] ✅ Click forzado exitoso en "${label}".`);
        return;
      } catch (forceErr) {
        lastBlockerInfo += ` | force también falló: ${forceErr.message.split('\n')[0]}`;
      }
    }
  }

  throw new Error(
    `No se pudo clickear "${label}" después de ${maxAttempts} intentos. ` +
    `Elemento bloqueando: ${lastBlockerInfo}`
  );
}

// Wraps an async action with reload+retry logic. If the action throws (e.g.
// a selector timeout because Suno rendered raw i18n keys instead of translated
// text), reloads the page and retries up to maxAttempts times total. The page
// is reloaded with waitUntil:'domcontentloaded' plus an extra 3-second settle window
// so translated text has time to appear. After exhausting retries, throws a
// descriptive error pointing at a likely Suno-side cause.
async function withReloadRetry(page, action, { maxAttempts = 3, description = 'operación' } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await action();
    } catch (err) {
      if (attempt === maxAttempts) {
        throw new Error(
          `[${description}] Falló después de ${maxAttempts} intentos con reload. ` +
          `Probable problema temporal de Suno (UI sin traducir o página incompleta). ` +
          `Error original: ${err.message}`
        );
      }
      console.log(
        `[suno-fill] Selector no encontrado, recargando página (intento ${attempt}/${maxAttempts})...`
      );
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);
    }
  }
}

async function clickByText(page, text) {
  const locator = page.getByRole('button', { name: text, exact: false })
    .or(page.getByRole('link', { name: text, exact: false }))
    .or(page.getByText(text, { exact: false }));
  await locator.first().waitFor({ state: 'visible', timeout: 20000 });
  await locator.first().click();
}

async function setSliderValue(page, ariaLabel, targetValue) {
  const slider = page.locator(`[role="slider"][aria-label="${ariaLabel}"]`);
  await slider.scrollIntoViewIfNeeded();
  await slider.evaluate((el) => el.focus());
  // Optimización de ejecución AGY: Previene cuelgues si el slider no responde o está deshabilitado
  let lastVal = -1;
  let noChangeCount = 0;
  for (let i = 0; i < 200; i++) {
    const current = parseInt(await slider.getAttribute('aria-valuenow'), 10);
    if (current === targetValue) break;
    if (current === lastVal) {
      noChangeCount++;
      if (noChangeCount >= 3) {
        throw new Error(`El slider "${ariaLabel}" no cambia de valor (fijado en ${current}). Abortando.`);
      }
    } else {
      noChangeCount = 0;
    }
    lastVal = current;
    await page.keyboard.press(current < targetValue ? 'ArrowRight' : 'ArrowLeft');
    await page.waitForTimeout(60);
  }
}

// Expands a collapsible panel (e.g. Suno's "More Options") only if it's not
// already expanded — toggling blindly can collapse a panel that was left open
// from a previous run (see LESSONS.md: "More Options toggle bug").
// Uses an explicit 10-second waitFor on the toggle text so that if Suno renders
// raw i18n keys (e.g. "createForm.advancedOptionsCardMoreOptions") the failure
// is fast and bubbles up to withReloadRetry rather than hanging for 30 seconds.
async function expandIfCollapsed(page, toggleText, probeLocator) {
  if ((await probeLocator.count()) === 0 || !(await probeLocator.isVisible())) {
    const toggle = page.getByText(toggleText, { exact: false }).first();
    await toggle.waitFor({ state: 'visible', timeout: 10000 });
    await safeClick(page, toggle, { label: `expandir "${toggleText}"`, maxAttempts: 3 });
    await page.waitForTimeout(500);
  }
}

// Connects to the long-lived Chrome instance started for Suno automation
// (launched standalone with --remote-debugging-port, never via
// launchPersistentContext — see LESSONS.md: "CDP lifecycle pattern") and
// returns its suno.com tab, brought to the front.
async function connectToSunoTab(chromium, debugPort = 9333) {
  const browser = await chromium.connectOverCDP(`http://localhost:${debugPort}`, { noDefaults: true });
  const contexts = browser.contexts();
  if (contexts.length === 0) throw new Error("No hay contextos de navegador disponibles");
  const context = contexts[0];
  const pages = context.pages();
  const page = pages.find((p) => p.url().includes('suno.com')) || pages[0];
  if (!page) {
    throw new Error('El Chrome del puerto de debug no tiene ninguna pestaña abierta. Abrí suno.com/create y volvé a correr.');
  }
  await page.bringToFront();
  return { browser, page };
}

// Misma idea que connectToSunoTab, pero para la pestaña del Artist Flow
// (cancioneterna.com). Usada por flow-submit.js y upload-to-flow.js — antes
// cada uno tenía su propia copia divergente (ver LESSONS.md, auditoría
// 2026-07-03). Lanza si no encuentra la tab; el caller decide si eso es un
// throw (flow-submit.js) o un console.error + process.exit (upload-to-flow.js).
async function connectToFlowTab(chromium, debugPort = 9333) {
  const browser = await chromium.connectOverCDP(`http://localhost:${debugPort}`, { noDefaults: true });
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error("No hay contextos de navegador disponibles");
  }
  const context = contexts[0];
  const pages = context.pages();
  const page = pages.find((p) => p.url().includes('cancioneterna.com'));
  if (!page) {
    const openUrls = pages.map((p) => p.url()).join(', ') || '(ninguna)';
    throw new Error(
      `No se encontró ninguna tab de cancioneterna.com en el Chrome del puerto ${debugPort}. Tabs abiertas: ${openUrls}`
    );
  }
  await page.bringToFront();
  return { browser, page };
}

// Checks whether the Suno tab is logged in: no "Sign in" text visible and at
// least one "Create" button present. Used by start-flow.js before handing off
// to suno-fill.js, instead of a one-off manual check each run.
async function isLoggedIn(page) {
  const signInCount = await page.getByText('Sign in', { exact: false }).count();
  const createButtonCount = await page.getByRole('button', { name: /create/i }).count();
  return signInCount === 0 && createButtonCount > 0;
}

// Espera un ENTER en la terminal (o el disparo de abortSignal). Base común
// de pauseForHumanInteraction y confirmToContinue — limpia siempre el
// listener de stdin para no dejar el proceso colgado ni handlers huérfanos.
function waitForEnterKey(abortSignal = null) {
  if (abortSignal && abortSignal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    let cleanup = () => {};

    const onData = () => {
      cleanup();
      resolve();
    };

    const onAbort = () => {
      cleanup();
      resolve();
    };

    cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
    };

    if (abortSignal) {
      abortSignal.addEventListener('abort', onAbort);
    }

    process.stdin.resume();
    process.stdin.once('data', onData);
  });
}

// Pausa el script infinitamente y notifica al usuario para que intervenga
// de forma manual en la UI (Fallback Interactivo).
async function pauseForHumanInteraction(reason, options = {}) {
  console.log('\x07'); // Emitir beep en terminal
  console.error(`\n======================================================`);
  console.error(`🚨 FALLBACK INTERACTIVO REQUERIDO 🚨`);
  console.error(`======================================================`);
  console.error(`Motivo: ${reason}`);
  console.error(`El script se ha pausado. Por favor, realiza la acción manualmente.`);
  console.error(`Presiona ENTER en esta terminal cuando hayas terminado para reanudar el script.`);
  console.error(`======================================================\n`);

  await notify(`Interacción manual requerida: ${reason}`, {
    title: '🚨 Acción Manual Requerida',
    priority: 'high',
    tags: 'warning'
  });

  return waitForEnterKey(options.abortSignal);
}

// Checkpoint de verificación humana (distinto del fallback de emergencia de
// arriba): el pipeline NO falló — está por hacer algo importante y espera un
// ENTER de confirmación antes de actuar. Avisa por ntfy qué está por pasar,
// para que Hector pueda venir a la terminal aunque no la esté mirando.
//   summary   — qué acaba de terminar / qué se está por hacer (multilínea OK).
//   nextAction— la acción concreta que se ejecuta al confirmar (para el ntfy).
async function confirmToContinue(summary, { nextAction = 'continuar', abortSignal = null } = {}) {
  console.log('\x07'); // beep — que se note aunque la terminal esté de fondo
  console.log('\n──────────────────────────────────────────────────────');
  console.log('✋ CHECKPOINT DE VERIFICACIÓN HUMANA');
  console.log('──────────────────────────────────────────────────────');
  console.log(summary);
  console.log(`\n➡️  Al confirmar: ${nextAction}`);
  console.log('Presioná ENTER en esta terminal para continuar.');
  console.log('──────────────────────────────────────────────────────\n');

  await notify(`${summary}\n\n➡️ Al confirmar: ${nextAction}\n(Esperando tu ENTER en la terminal)`, {
    title: '✋ Verificación requerida',
    priority: 'high',
    tags: 'hand',
  });

  await waitForEnterKey(abortSignal);
  console.log('✅ Confirmado — continuando.\n');
}

module.exports = { safeClick, identifyBlocker, isClickable, clickByText, setSliderValue, expandIfCollapsed, withReloadRetry, connectToSunoTab, connectToFlowTab, isLoggedIn, isPortUp, ensurePortIsFree, pauseForHumanInteraction, confirmToContinue, waitForEnterKey };
