const { chromium } = require('playwright');
const fs = require('fs');
const { connectToSunoTab } = require('./lib/playwright-helpers');
const selectors = require('./lib/suno-selectors');

async function main() {
  console.log('Iniciando detector de drift de selectores...');
  let browser, page;
  try {
    const connected = await connectToSunoTab(chromium, 9333);
    browser = connected.browser;
    page = connected.page;
  } catch (e) {
    console.error('Error conectando a Chrome en puerto 9333:', e.message);
    console.log('Asegurate de que Chrome este corriendo en el puerto 9333 (node suno-open-for-login.js)');
    process.exit(1);
  }

  // Asegurarnos de estar en /create
  if (!page.url().includes('suno.com/create')) {
    console.log('Navegando a suno.com/create...');
    await page.goto('https://suno.com/create', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
  } else {
    console.log('Ya estamos en suno.com/create.');
  }
  
  // Darle un poco de tiempo para asegurar que el DOM este listo
  await page.waitForTimeout(2000);

  let driftCount = 0;
  const report = [];
  report.push('# Reporte de Selectores de Suno (Drift Detector)\n');
  report.push(`Fecha: ${new Date().toISOString()}\n`);
  report.push('| Selector | Estado | Observaciones |');
  report.push('| --- | --- | --- |');

  const checks = [
    { name: 'LYRICS_TEXTAREA', loc: page.locator(selectors.LYRICS_TEXTAREA) },
    { name: 'TITLE_INPUT', loc: page.locator(selectors.TITLE_INPUT) },
    { name: 'EXPAND_LYRICS_BOX_LABEL', loc: page.getByLabel(selectors.EXPAND_LYRICS_BOX_LABEL).or(page.getByText(selectors.EXPAND_LYRICS_BOX_LABEL, { exact: false })) },
    { name: 'STYLE_TEXTAREA', loc: page.locator(selectors.STYLE_TEXTAREA) },
    { name: 'MORE_OPTIONS_TOGGLE_TEXT', loc: page.getByText(selectors.MORE_OPTIONS_TOGGLE_TEXT, { exact: false }) },
    { name: 'WEIRDNESS_SLIDER_LABEL', loc: page.locator(`[role="slider"][aria-label="${selectors.WEIRDNESS_SLIDER_LABEL}"]`).or(page.getByLabel(selectors.WEIRDNESS_SLIDER_LABEL)) },
    { name: 'STYLE_INFLUENCE_SLIDER_LABEL', loc: page.locator(`[role="slider"][aria-label="${selectors.STYLE_INFLUENCE_SLIDER_LABEL}"]`).or(page.getByLabel(selectors.STYLE_INFLUENCE_SLIDER_LABEL)) },
    { name: 'CREATE_SONG_ROLE_NAME', loc: page.getByRole('button', { name: selectors.CREATE_SONG_ROLE_NAME }).or(page.getByRole('button', { name: 'Create', exact: true })) },
    { name: 'CREATE_SONG_ARIA_SELECTOR', loc: page.locator(selectors.CREATE_SONG_ARIA_SELECTOR) },
    { name: 'MORE_OPTIONS_MENU_ARIA_SELECTOR', loc: page.locator(selectors.MORE_OPTIONS_MENU_ARIA_SELECTOR) },
    { name: 'CLIP_ROW', loc: page.locator(selectors.CLIP_ROW) },
    { name: 'Download (Botón en menú)', loc: page.getByRole('button', { name: 'Download', exact: true }).or(page.locator('button').filter({ hasText: /^download$/i })) },
    { name: 'MP3 Audio (Botón en submenú)', loc: page.locator('button[aria-label="MP3 Audio"]').or(page.getByRole('button', { name: 'MP3 Audio', exact: true })) },
  ];

  for (const check of checks) {
    try {
      const count = await check.loc.count();
      let isVisible = false;
      if (count > 0) {
        // En lugar de chequear el primero, vemos si ALGUNO es visible
        for (let i = 0; i < count; i++) {
          if (await check.loc.nth(i).isVisible()) {
            isVisible = true;
            break;
          }
        }
      }

      let status = '❌';
      let obs = '';
      // Los ítems del menú ⋯ (Download/MP3) no se renderizan hasta abrir el
      // menú, y este script es de SOLO lectura (jamás clickea) — su ausencia
      // es esperada y no cuenta como drift.
      const isExpectedHidden = check.name.includes('Download') || check.name.includes('MP3');

      if (count > 0 && isVisible) {
        status = '✅';
        obs = `Encontrado y visible (${count} matches).`;
      } else if (count > 0 && !isVisible) {
        status = '⚠️';
        obs = `Existe en el DOM (${count} matches), pero 0 visibles.`;
        if (isExpectedHidden) obs += ' (Esperado: menú ⋯ no abierto por regla de solo lectura)';
      } else {
        status = '❌';
        obs = 'No encontrado en el DOM.';
        if (isExpectedHidden) {
          obs += ' (Esperado: Radix UI no renderiza el menú hasta abrirlo, no clickeado por regla de solo lectura)';
        } else {
          driftCount++;
        }
      }

      report.push(`| ${check.name} | ${status} | ${obs} |`);
      console.log(`${status} ${check.name}: ${obs}`);
    } catch (e) {
      report.push(`| ${check.name} | ❌ | Error al evaluar: ${e.message} |`);
      console.log(`❌ ${check.name}: Error al evaluar: ${e.message}`);
      if (!(check.name.includes('Download') || check.name.includes('MP3'))) driftCount++;
    }
  }

  const reportText = report.join('\n');
  fs.writeFileSync('selector-drift-report.md', reportText);
  console.log('\nReporte guardado en selector-drift-report.md');
  await browser.close().catch(() => {});

  // Códigos de salida para el corredor automático (watchdog, 2026-07-14):
  //   0 = sin drift · 2 = drift detectado (selector crítico ausente) ·
  //   1 = no se pudo correr (Chrome/puerto — ya manejado arriba con exit(1)).
  if (driftCount > 0) {
    console.log(`\n🚨 DRIFT: ${driftCount} selector(es) crítico(s) no encontrados — revisar lib/suno-selectors.js antes de la próxima canción.`);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
