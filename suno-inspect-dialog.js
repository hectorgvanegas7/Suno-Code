const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9333');
  const context = browser.contexts()[0];
  const pages = context.pages();
  const page = pages.find((p) => p.url().includes('suno.com')) || pages[0];

  const dialogInfo = await page.evaluate(() => {
    const dialog = document.querySelector('[role="alertdialog"]');
    if (!dialog) return null;
    const buttons = Array.from(dialog.querySelectorAll('button')).map((b) => b.textContent.trim());
    return { html: dialog.outerHTML.slice(0, 1500), buttons };
  });
  console.log(JSON.stringify(dialogInfo, null, 2));

  await page.screenshot({ path: 'suno-dialog-state.png' });
  await browser.close().catch(() => {});
})().catch((err) => {
  console.error('Inspect failed:', err);
});
