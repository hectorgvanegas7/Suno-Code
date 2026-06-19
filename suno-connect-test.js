const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9333');
  const contexts = browser.contexts();
  const context = contexts[0];
  const pages = context.pages();
  const page = pages.find(p => p.url().includes('suno.com')) || pages[0];
  console.log('Connected to:', page.url());

  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1000);

  await page.getByText('More Options', { exact: false }).first().click();
  await page.waitForTimeout(500);

  const slider = page.locator('[role="slider"][aria-label="Weirdness"]');
  await slider.scrollIntoViewIfNeeded();

  const beforeInfo = await slider.evaluate((el) => ({
    tabIndex: el.tabIndex,
    tag: el.tagName,
    valuenow: el.getAttribute('aria-valuenow'),
  }));
  console.log('Before:', beforeInfo);

  await slider.click();
  const activeMatches = await slider.evaluate((el) => el === document.activeElement);
  console.log('Slider is document.activeElement after click:', activeMatches);

  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  const afterArrow = await slider.getAttribute('aria-valuenow');
  console.log('Value after one ArrowRight:', afterArrow);

  // Try focusing via JS directly then pressing arrow
  await slider.evaluate((el) => el.focus());
  const activeMatches2 = await slider.evaluate((el) => el === document.activeElement);
  console.log('Slider is document.activeElement after el.focus():', activeMatches2);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  const afterArrow2 = await slider.getAttribute('aria-valuenow');
  console.log('Value after el.focus() + ArrowRight:', afterArrow2);

  // Disconnect without closing the browser
  await browser.close().catch(() => {});
})().catch((err) => {
  console.error('Test failed:', err);
});
