const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9333');
  const context = browser.contexts()[0];
  const pages = context.pages();
  const page = pages.find((p) => p.url().includes('cancioneterna.com')) || pages[0];
  await page.bringToFront();
  await page.waitForLoadState('networkidle').catch(() => {});
  console.log('URL:', page.url());
  await page.screenshot({ path: '_flow-state.png' });
  console.log('screenshot saved');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
