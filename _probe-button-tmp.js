const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9333');
  const context = browser.contexts()[0];
  const pages = context.pages();
  const page = pages.find((p) => p.url().includes('cancioneterna.com')) || pages[0];
  await page.bringToFront();

  const btn = page.getByRole('button', { name: 'Assign Most Urgent Song', exact: false });
  console.log('button count:', await btn.count());
  if ((await btn.count()) > 0) {
    console.log('visible:', await btn.first().isVisible());
    console.log('enabled:', await btn.first().isEnabled());
    await btn.first().click();
    console.log('clicked');
  }
  await page.waitForTimeout(3000);
  await page.waitForLoadState('networkidle').catch(() => {});
  console.log('URL after click:', page.url());
  await page.screenshot({ path: '_flow-state.png' });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
