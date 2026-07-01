// Shared Playwright helpers for the Canción Eterna automation scripts
// (run.js, suno-fill.js, suno-create.js). See LESSONS.md for the bugs
// that led to some of these.

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
  for (let i = 0; i < 200; i++) {
    const current = parseInt(await slider.getAttribute('aria-valuenow'), 10);
    if (current === targetValue) break;
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
  const browser = await chromium.connectOverCDP(`http://localhost:${debugPort}`);
  const context = browser.contexts()[0];
  const pages = context.pages();
  const page = pages.find((p) => p.url().includes('suno.com')) || pages[0];
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

module.exports = { safeClick, identifyBlocker, isClickable, clickByText, setSliderValue, expandIfCollapsed, withReloadRetry, connectToSunoTab, isLoggedIn };
