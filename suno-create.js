const { chromium } = require('playwright');
const { connectToSunoTab } = require('./lib/playwright-helpers');

// Clickea "Create song" dos veces (Suno genera 2 versiones por canción).
// Entre clics esperamos a que el botón vuelva a estar accionable en vez de un
// timeout fijo a ciegas — si Suno está lento, 3s fijos podían no alcanzar y el
// segundo clic se perdía.
(async () => {
  const { browser, page } = await connectToSunoTab(chromium);

  const createBtn = page.getByRole('button', { name: 'Create song' });
  await createBtn.first().waitFor({ state: 'visible', timeout: 15000 });

  await createBtn.first().click();
  console.log('Primer clic en Create realizado.');

  // Esperar a que el botón esté de nuevo listo para el segundo clic.
  await page.waitForTimeout(1500);
  try {
    await createBtn.first().waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('button[aria-label="Create song"]') ||
                    [...document.querySelectorAll('button')].find((b) =>
                      /create song/i.test(b.getAttribute('aria-label') || '')
                    );
        return btn && !btn.disabled && !btn.hasAttribute('data-disabled');
      },
      { timeout: 8000 }
    ).catch(() => {});
  } catch {
    /* si no reaparece, intentamos el segundo clic igual */
  }

  await createBtn.first().click();
  console.log('Segundo clic en Create realizado.');
  await page.waitForTimeout(1500);

  await page.screenshot({ path: 'suno-after-create.png' });
  console.log('Listo. Chrome queda abierto.');

  await browser.close().catch(() => {});
})().catch((err) => {
  console.error('Create failed:', err);
  process.exit(1);
});
