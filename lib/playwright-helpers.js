// Shared Playwright helpers for the Canción Eterna automation scripts
// (run.js, suno-fill.js, suno-create.js). See LESSONS.md for the bugs
// that led to some of these.

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
    await toggle.click();
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

module.exports = { clickByText, setSliderValue, expandIfCollapsed, withReloadRetry, connectToSunoTab, isLoggedIn };
