// Shared Playwright helpers for the Canción Eterna automation scripts
// (run.js, suno-fill.js, suno-create.js). See LESSONS.md for the bugs
// that led to some of these.

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
async function expandIfCollapsed(page, toggleText, probeLocator) {
  if ((await probeLocator.count()) === 0 || !(await probeLocator.isVisible())) {
    await page.getByText(toggleText, { exact: false }).first().click();
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

module.exports = { clickByText, setSliderValue, expandIfCollapsed, connectToSunoTab };
