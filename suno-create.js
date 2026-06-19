const { chromium } = require('playwright');
const { connectToSunoTab } = require('./lib/playwright-helpers');

(async () => {
  const { browser, page } = await connectToSunoTab(chromium);

  const createBtn = page.getByRole('button', { name: 'Create song' });
  await createBtn.click();
  console.log('Primer clic en Create realizado.');
  await page.waitForTimeout(3000);
  await createBtn.click();
  console.log('Segundo clic en Create realizado.');
  await page.waitForTimeout(1500);

  await page.screenshot({ path: 'suno-after-create.png' });
  console.log('Listo. Chrome queda abierto.');

  await browser.close().catch(() => {});
})().catch((err) => {
  console.error('Create failed:', err);
  process.exit(1);
});
