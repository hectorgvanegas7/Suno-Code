const { chromium } = require('playwright');
const { connectToSunoTab } = require('./lib/playwright-helpers');

// Clickea "Create song" UNA SOLA VEZ — Suno v5.5 genera 2 versiones por click.
// El doble click era el diseño correcto para la versión vieja de Suno; hoy
// genera 4 canciones y quema créditos de más (mismo criterio que
// lib/suno-create-dl.js, que es el camino automático; este script es el
// fallback manual y tiene que comportarse igual).
(async () => {
  const { browser, page } = await connectToSunoTab(chromium);

  const createBtn = page.getByRole('button', { name: 'Create song' });
  await createBtn.first().waitFor({ state: 'visible', timeout: 15000 });

  await createBtn.first().click();
  console.log('Click en Create realizado (Suno genera 2 versiones con un solo click).');
  await page.waitForTimeout(1500);

  await page.screenshot({ path: 'suno-after-create.png' });
  console.log('Listo. Chrome queda abierto.');

  // browser.close() sobre connectOverCDP solo desconecta el socket — Chrome
  // sigue corriendo. Sin esta desconexión, Node queda colgado para siempre.
  await browser.close().catch(() => {});
})().catch((err) => {
  console.error('Create failed:', err);
  process.exit(1);
});
