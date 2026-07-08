const { chromium } = require('playwright');
const { connectToSunoTab, safeClick } = require('./lib/playwright-helpers');
const { CLIP_ROW, MORE_OPTIONS_MENU_ARIA_SELECTOR } = require('./lib/suno-selectors');

const DEBUG_PORT = 9333;
const CLICK_ATTEMPTS = 10;

async function tryOpenDownloadMp3(page, row) {
  // Close any previously opened menus
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);

  const moreBtn = row.locator(MORE_OPTIONS_MENU_ARIA_SELECTOR).first();
  if ((await moreBtn.count()) === 0) {
    console.log("    - No se encontro el boton ⋯");
    return 'no-menu';
  }

  await safeClick(page, moreBtn, { label: `⋯ (More Options)`, maxAttempts: 3 });
  await page.waitForTimeout(500);

  const downloadItem = page.getByRole('button', { name: 'Download', exact: true })
    .or(page.locator('button').filter({ hasText: /^download$/i }))
    .first();
  try {
    await downloadItem.waitFor({ state: 'visible', timeout: 4000 });
  } catch {
    await page.keyboard.press('Escape').catch(() => {});
    console.log("    - No se encontro la opcion Download");
    return 'no-menu';
  }

  const mp3Item = page.locator('button[aria-label="MP3 Audio"]')
    .or(page.getByRole('button', { name: 'MP3 Audio', exact: true }))
    .first();

  let mp3Visible = false;
  for (let h = 1; h <= 3; h++) {
    await downloadItem.hover().catch(() => {});
    await page.waitForTimeout(500);
    if (await mp3Item.count() > 0 && await mp3Item.first().isVisible().catch(() => false)) {
      mp3Visible = true;
      break;
    }
    // Teclado fallback
    await downloadItem.focus().catch(() => {});
    await page.keyboard.press('ArrowRight').catch(() => {});
    await page.waitForTimeout(500);
    if (await mp3Item.count() > 0 && await mp3Item.first().isVisible().catch(() => false)) {
      mp3Visible = true;
      break;
    }
    if (h === 3) {
      await downloadItem.click().catch(() => {});
      await page.waitForTimeout(500);
    }
  }

  for (let i = 0; i < 6; i++) {
    if (await mp3Item.count() > 0 && await mp3Item.first().isVisible().catch(() => false)) {
      mp3Visible = true;
      break;
    }
    await downloadItem.hover().catch(() => {});
    await page.waitForTimeout(500);
  }

  if (!mp3Visible) {
    await page.keyboard.press('Escape').catch(() => {});
    console.log("    - No se mostro la opcion MP3 Audio (quiza 'preparing...')");
    return 'not-ready';
  }

  const mp3Text = await mp3Item.first().textContent().catch(() => '');
  if (/wav|lossless/i.test(mp3Text) && !/mp3/i.test(mp3Text)) {
    await page.keyboard.press('Escape').catch(() => {});
    console.log("    - Era opcion WAV/Lossless, skip");
    return 'not-ready';
  }

  await mp3Item.first().hover().catch(() => {});
  await page.waitForTimeout(150);
  await mp3Item.first().click({ timeout: 4000 }).catch(async () => {
    await mp3Item.first().click({ force: true }).catch(() => {});
  });

  return 'clicked';
}

async function runDiagnosis() {
  console.log("Conectando a Chrome en puerto 9333 (127.0.0.1)...");
  
  let browser, page, context;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`, { noDefaults: true });
    const contexts = browser.contexts();
    if (contexts.length === 0) throw new Error("No hay contextos");
    context = contexts[0];
    const pages = context.pages();
    page = pages.find((p) => p.url().includes('suno.com')) || pages[0];
    if (!page) {
      throw new Error('Sin pestañas');
    }
    await page.bringToFront();
  } catch (e) {
    console.log(`Fallo conexión inicial (${e.message}). Lanzando Chrome automáticamente...`);
    const USER_DATA_DIR = 'C:\\Users\\hecto\\AppData\\Local\\ChromeAutomationProfile';
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      channel: 'chrome',
      headless: false,
      acceptDownloads: true,
      args: ['--profile-directory=Profile 1', '--remote-debugging-port=9333']
    });
    const pages = context.pages();
    page = pages.find((p) => p.url().includes('suno.com')) || pages[0];
    await page.goto('https://suno.com/create', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
    browser = context; // launchPersistentContext devuelve el context que actúa como browser en la API
  }


  // Configuramos un manejador para descargas y logs
  let lastClickTime = 0;
  let downloadTriggered = false;
  let downloadDelayMs = 0;
  let consoleErrors = [];

  page.on('download', download => {
    downloadTriggered = true;
    downloadDelayMs = Date.now() - lastClickTime;
    console.log(`    >> Evento 'download' disparado en ${downloadDelayMs}ms. URL: ${download.url()}`);
    // No esperamos a que baje, cancelamos para no saturar
    download.cancel().catch(() => {});
  });

  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
  
  page.on('pageerror', err => {
    consoleErrors.push(err.message);
  });

  try {
    console.log("Buscando cards ya generadas (sin spinner)...");
    const rows = await page.evaluate(({ clipRowSelector }) => {
      const els = [...document.querySelectorAll(clipRowSelector)];
      return els.map((el, i) => {
        const hasSpinner = !!el.querySelector(
          '[role="progressbar"], [aria-busy="true"], [class*="spin" i], [class*="loading" i], [class*="pulse" i]'
        );
        const text = el.textContent || '';
        const hasGeneratingText = /\b(creating|generating|queued|pending|loading)\b|\d+\s*%/i.test(text);
        const titleEl = el.querySelector('a.hover\\:underline');
        const title = titleEl ? titleEl.textContent.trim() : 'Unknown';
        return { index: i, ready: !hasSpinner && !hasGeneratingText, title };
      }).filter(r => r.ready);
    }, { clipRowSelector: CLIP_ROW });

    if (rows.length === 0) {
      console.log("No se encontraron cards listas.");
      return;
    }

    console.log(`Se encontraron ${rows.length} cards listas. Se evaluarán hasta ${CLICK_ATTEMPTS} clicks.`);
    
    // Configurar comportamiento de descarga para que no pregunte donde guardar
    try {
      const session = browser.newBrowserCDPSession ? await browser.newBrowserCDPSession() : await browser.newCDPSession(page);
      await session.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: __dirname,
        eventsEnabled: true,
      });
    } catch (e) {
      console.log("    - No se pudo configurar CDP (probablemente usando launchPersistentContext), se asume acceptDownloads=true.");
    }

    const results = [];

    for (let i = 0; i < Math.min(rows.length, CLICK_ATTEMPTS); i++) {
      const cardInfo = rows[i];
      console.log(`\nPrueba ${i + 1}/${CLICK_ATTEMPTS} - Card: "${cardInfo.title}"`);
      
      const rowLoc = page.locator(CLIP_ROW).nth(cardInfo.index);
      
      downloadTriggered = false;
      downloadDelayMs = 0;
      consoleErrors = [];
      lastClickTime = Date.now();
      
      const clickResult = await tryOpenDownloadMp3(page, rowLoc);
      
      if (clickResult === 'clicked') {
        // Esperamos hasta 10 segundos para ver si el evento 'download' salta.
        console.log("    - Click realizado. Esperando evento 'download'...");
        let waited = 0;
        while (!downloadTriggered && waited < 10000) {
          await page.waitForTimeout(500);
          waited += 500;
        }
        
        if (downloadTriggered) {
          console.log(`    - EXITOSO: Evento de descarga detectado (${downloadDelayMs}ms).`);
        } else {
          console.log(`    - FALLO: El evento de descarga NO se disparó en 10s.`);
        }
        
        if (consoleErrors.length > 0) {
          console.log(`    - Errores de consola: ${consoleErrors.length}`);
          consoleErrors.forEach(err => console.log(`      * ${err}`));
        }
      }

      results.push({
        test: i + 1,
        title: cardInfo.title,
        clickResult,
        downloadTriggered,
        downloadDelayMs,
        errors: [...consoleErrors]
      });
      
      // Cleanup DOM popups
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(1000); // Wait before next card
    }

    console.log("\n===========================");
    console.log("Resumen del diagnóstico:");
    results.forEach(r => {
      console.log(`Prueba ${r.test}: Click: ${r.clickResult}, Evento DL: ${r.downloadTriggered}, Latencia: ${r.downloadDelayMs}ms, Errores: ${r.errors.length}`);
    });

  } finally {
    await browser.close().catch(() => {});
  }
}

runDiagnosis().catch(e => console.error("Error global:", e));
