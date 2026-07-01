// lib/suno-create-dl.js — Clickea Create en Suno, espera la generación de AMBAS
// versiones y descarga los MP3 a Downloads/suno/.
//
// Reemplaza el paso manual de clickear Create + descargar.
// La verificación visual por screenshot sigue siendo obligatoria: este módulo
// comprueba programáticamente que el formulario tiene los campos correctos ANTES
// de clickear Create. Si algo no pasa la verificación, aborta sin clickear.
//
// Selector strategy para descarga: extrae los URLs de audio del DOM una vez que
// los src de los elementos <audio> apuntan a CDN de Suno. Descarga vía fetch
// desde el contexto de la página (con cookies/sesión activa). Si esto falla,
// cae a un método alternativo que intenta el menú de descarga de la UI.
//
// GARANTÍAS:
//   - Nunca clickea más de 2 veces en Create (para no crear canciones extra).
//   - Nunca hace Submit to QA. Nunca toca el Flow.
//   - Si la descarga falla, informa claramente qué falta — no aborta silenciosamente.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { SUNO_DIR } = require('./audio-match');

const DEBUG_PORT = 9333;
const GENERATION_TIMEOUT_MS = 8 * 60 * 1000; // 8 minutos

// ─── Helpers ─────────────────────────────────────────────────────────────────

function slugify(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);
}

async function connectToSunoTab() {
  const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
  const context = browser.contexts()[0];
  const pages = context.pages();
  const page = pages.find((p) => p.url().includes('suno.com')) || pages[0];
  await page.bringToFront();
  return { browser, context, page };
}

// Configura Chrome para que las descargas vayan a sunoDir.
// Usa Browser.setDownloadBehavior (CDP moderno) con fallback a Page.setDownloadBehavior.
async function configureDownloadDir(browser, sunoDir) {
  fs.mkdirSync(sunoDir, { recursive: true });
  try {
    const session = await browser.newBrowserCDPSession();
    await session.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: sunoDir,
      eventsEnabled: true,
    });
    console.log(`  [download] Directorio configurado (CDP Browser): ${sunoDir}`);
    return session;
  } catch (e) {
    console.log(`  [download] Browser.setDownloadBehavior falló: ${e.message}`);
    console.log('  [download] Las descargas irán a la carpeta de Downloads por defecto.');
    return null;
  }
}

// ─── Verificación del formulario ANTES de clickear Create ────────────────────

// Comprueba que el formulario de Suno está en estado correcto para generar.
// Si algo está mal, devuelve { ok: false, reason }. Si está bien, { ok: true }.
async function verifyFormBeforeCreate(page) {
  try {
    const lyricsEl = page.locator('[data-testid="lyrics-textarea"]');
    if ((await lyricsEl.count()) === 0) {
      return { ok: false, reason: 'No se encontró el campo de letra [data-testid="lyrics-textarea"]' };
    }

    const lyricsValue = await lyricsEl.inputValue();

    // Check: la letra no puede contener el bloque de advertencias
    if (/\*\*Advertencias:\*\*/i.test(lyricsValue)) {
      return { ok: false, reason: 'El campo de letra contiene el bloque **Advertencias:** — el parser no lo eliminó. Corregí manualmente.' };
    }

    // Check: debe tener las 6 secciones
    const sections = ['[Verse 1]', '[Chorus 1]', '[Verse 2]', '[Chorus 2]', '[Bridge]', '[Outro]'];
    const missing = sections.filter((s) => !lyricsValue.includes(s));
    if (missing.length > 0) {
      return { ok: false, reason: `Secciones faltantes en la letra: ${missing.join(', ')}` };
    }

    // Check: debe haber un título
    const titleInputs = page.locator('input[placeholder="Song Title (Optional)"]');
    const titleCount = await titleInputs.count();
    let titleValue = '';
    for (let i = 0; i < titleCount; i++) {
      if (await titleInputs.nth(i).isVisible()) {
        titleValue = await titleInputs.nth(i).inputValue();
        break;
      }
    }
    if (!titleValue.trim()) {
      return { ok: false, reason: 'El campo de título está vacío en Suno.' };
    }

    return { ok: true, titulo: titleValue.trim(), lyricsLength: lyricsValue.length };
  } catch (e) {
    return { ok: false, reason: `Error al verificar formulario: ${e.message}` };
  }
}

// ─── Esperar generación ───────────────────────────────────────────────────────

// Espera hasta que AMBAS canciones terminen de generarse.
// Señal concreta: aparecen 2 elementos <audio> con src apuntando al CDN de Suno.
// Timeout generoso: 8 minutos.
// Devuelve array de { url, index } para cada canción completada.
async function waitForBothSongs(page, expectedCount = 2) {
  console.log(`  Esperando que ${expectedCount} versión(es) terminen de generarse...`);
  console.log('  (Esto suele tardar entre 1 y 4 minutos — no cerres Chrome)');

  const startTime = Date.now();

  const handle = await page.waitForFunction(
    (count) => {
      // Buscar audio elements con src que apunten al CDN de Suno
      const audios = Array.from(document.querySelectorAll('audio'));
      const withSrc = audios.filter((a) => {
        const src = a.src || (a.querySelector('source') ? a.querySelector('source').src : '');
        return src && src.length > 10 && !src.startsWith('blob:') && (
          src.includes('cdn') || src.includes('suno') || src.includes('.mp3')
        );
      });
      return withSrc.length >= count ? withSrc.map((a) => ({
        src: a.src || a.querySelector('source')?.src,
        id: a.id || a.dataset?.songId || '',
      })) : null;
    },
    expectedCount,
    { timeout: GENERATION_TIMEOUT_MS, polling: 3000 }
  );

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const audioData = await handle.jsonValue();
  console.log(`  ✅ ${audioData.length} versión(es) generadas en ${elapsed}s`);
  return audioData;
}

// ─── Descarga desde contexto de página ───────────────────────────────────────

// Descarga un MP3 desde una URL usando el contexto de la página (cookies de sesión).
// Devuelve la ruta local del archivo descargado, o lanza si falla.
async function downloadFromPage(page, url, destPath) {
  console.log(`  Descargando: ${path.basename(destPath)}`);
  console.log(`  URL: ${url.substring(0, 80)}...`);

  // Intentar con fetch desde la página (tiene las cookies de Suno)
  const buffer = await page.evaluate(async (audioUrl) => {
    try {
      const response = await fetch(audioUrl, { credentials: 'include' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      return Array.from(new Uint8Array(arrayBuffer));
    } catch (e) {
      return { error: e.message };
    }
  }, url);

  if (!Array.isArray(buffer)) {
    throw new Error(`Fetch desde página falló: ${buffer.error || 'error desconocido'}`);
  }

  fs.writeFileSync(destPath, Buffer.from(buffer));
  const stat = fs.statSync(destPath);
  if (stat.size < 10000) {
    throw new Error(`Archivo descargado demasiado pequeño (${stat.size} bytes) — posiblemente corrupto`);
  }
  console.log(`  ✅ Guardado: ${destPath} (${Math.round(stat.size / 1024)} KB)`);
  return destPath;
}

// Fallback: intenta descargar via el menú "..." → "Download" de Suno.
// Retorna el path si lo detecta en Downloads/suno/, null si no puede.
async function downloadViaMenu(page, cardIndex, sunoDir, expectedTitle) {
  console.log(`  [fallback] Intentando descarga vía menú UI (canción ${cardIndex + 1})...`);
  try {
    // Buscar botones de "más opciones" cerca de los song cards
    // Suno usa diferentes selectores según la versión — probamos varios
    const menuSelectors = [
      `[aria-label*="more" i]`,
      `[aria-label*="options" i]`,
      `[data-testid*="more" i]`,
      `button[aria-haspopup="menu"]`,
    ];

    let menuBtn = null;
    for (const sel of menuSelectors) {
      const btns = await page.locator(sel).all();
      if (btns.length > cardIndex) {
        menuBtn = btns[cardIndex];
        break;
      }
    }

    if (!menuBtn) {
      console.log('  [fallback] No se encontró botón de menú.');
      return null;
    }

    await menuBtn.click();
    await page.waitForTimeout(800);

    // Buscar opción "Download" en el menú desplegable
    const downloadItem = page.getByRole('menuitem', { name: /download/i }).or(
      page.getByText(/download/i, { exact: false })
    ).first();

    if ((await downloadItem.count()) === 0) {
      console.log('  [fallback] No se encontró opción Download en el menú.');
      await page.keyboard.press('Escape');
      return null;
    }

    await downloadItem.click();
    await page.waitForTimeout(500);

    // Buscar opción MP3 en el submenú/popup
    const mp3Btn = page.getByText(/mp3/i, { exact: false }).first();
    if ((await mp3Btn.count()) > 0) {
      await mp3Btn.click();
      console.log('  [fallback] Click en MP3. Esperando descarga...');
    }

    // Esperar que aparezca el archivo en Downloads/suno/
    const before = new Set(fs.readdirSync(sunoDir).map((f) => path.join(sunoDir, f)));
    await page.waitForTimeout(5000);

    const after = fs.readdirSync(sunoDir).filter((f) => f.endsWith('.mp3') || f.endsWith('.crdownload'));
    const newFiles = after.filter((f) => !before.has(path.join(sunoDir, f)));

    if (newFiles.length > 0) {
      const fullPath = path.join(sunoDir, newFiles[0]);
      console.log(`  [fallback] Descargado: ${newFiles[0]}`);
      return fullPath;
    }

    return null;
  } catch (e) {
    console.log(`  [fallback] Error: ${e.message}`);
    return null;
  }
}

// ─── Punto de entrada público ─────────────────────────────────────────────────

// Conecta al Chrome de Suno, verifica el formulario, clickea Create (x2),
// espera generación y descarga ambos MP3. Devuelve { versionA, versionB } con rutas.
// Lanza si hay un error no recuperable.
async function createAndDownload({ sunoDir = SUNO_DIR } = {}) {
  fs.mkdirSync(sunoDir, { recursive: true });

  const { browser, context, page } = await connectToSunoTab();

  try {
    // 1. Verificación del formulario ANTES de Create
    console.log('  Verificando formulario antes de clickear Create...');
    const verify = await verifyFormBeforeCreate(page);
    if (!verify.ok) {
      throw new Error(`Verificación fallida — Create cancelado: ${verify.reason}`);
    }
    console.log(`  ✅ Formulario OK. Título: "${verify.titulo}", letra: ${verify.lyricsLength} chars`);

    // Configurar directorio de descarga vía CDP
    await configureDownloadDir(browser, sunoDir);

    // 2. Click Create × 2 (Suno genera 2 versiones por canción)
    const createBtn = page.getByRole('button', { name: /create/i }).first();
    await createBtn.waitFor({ state: 'visible', timeout: 15000 });

    console.log('  Click #1 en Create...');
    await createBtn.click();
    console.log('  ✅ Primer Create.');

    // Esperar a que el botón vuelva a estar activo para el segundo click
    await page.waitForTimeout(1500);
    try {
      await page.waitForFunction(
        () => {
          const btn = [...document.querySelectorAll('button')].find((b) =>
            /create/i.test(b.textContent || b.getAttribute('aria-label') || '')
          );
          return btn && !btn.disabled && !btn.getAttribute('aria-disabled');
        },
        { timeout: 10000 }
      ).catch(() => {});
    } catch {}

    console.log('  Click #2 en Create...');
    await createBtn.click().catch(() => {
      // Si el botón ya no está, la canción ya se inició con el primer click
      console.log('  (El botón Create ya no estaba disponible — la canción se inició con el primer click)');
    });
    console.log('  ✅ Segundo Create.');

    await page.screenshot({ path: 'suno-after-create.png' });

    // 3. Esperar que ambas canciones terminen de generarse
    let audioData;
    try {
      audioData = await waitForBothSongs(page, 2);
    } catch (e) {
      // Si solo hay 1, intentar con 1
      console.log(`  ⚠️ No se encontraron 2 canciones en ${GENERATION_TIMEOUT_MS / 60000} min. Intentando con 1...`);
      try {
        audioData = await waitForBothSongs(page, 1);
        console.log('  ⚠️ Solo se encontró 1 versión generada.');
      } catch {
        throw new Error(
          `Timeout esperando generación de canciones (${GENERATION_TIMEOUT_MS / 60000} min). ` +
          'Verificá el estado de Suno en el navegador.'
        );
      }
    }

    // 4. Descargar cada MP3
    const slug = slugify(verify.titulo);
    const now = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const versionLabels = ['A', 'B'];

    const downloadedPaths = [];
    for (let i = 0; i < Math.min(audioData.length, 2); i++) {
      const { src } = audioData[i];
      const versionLabel = versionLabels[i];
      const destPath = path.join(sunoDir, `${dateStr}-${slug}-${versionLabel}.mp3`);

      console.log(`\n  Descargando Versión ${versionLabel}...`);
      try {
        await downloadFromPage(page, src, destPath);
        downloadedPaths.push({ label: versionLabel, path: destPath });
      } catch (e) {
        console.log(`  ⚠️ Descarga directa falló: ${e.message}`);
        console.log('  Intentando fallback via menú UI...');
        const fallbackPath = await downloadViaMenu(page, i, sunoDir, verify.titulo);
        if (fallbackPath) {
          // Renombrar al nombre esperado
          try {
            fs.renameSync(fallbackPath, destPath);
            downloadedPaths.push({ label: versionLabel, path: destPath });
          } catch {
            downloadedPaths.push({ label: versionLabel, path: fallbackPath });
          }
        } else {
          console.log(`  ❌ No se pudo descargar la Versión ${versionLabel}. Descargala manualmente de Suno.`);
          console.log(`     Guardala en: ${sunoDir} con nombre que incluya el título.`);
        }
      }
    }

    if (downloadedPaths.length === 0) {
      throw new Error('No se pudo descargar ninguna versión. Descargalas manualmente de Suno.');
    }

    console.log(`\n  ✅ Descarga completa. Archivos en ${sunoDir}:`);
    for (const { label, path: p } of downloadedPaths) {
      console.log(`     Versión ${label}: ${path.basename(p)}`);
    }

    return {
      versionA: downloadedPaths[0] || null,
      versionB: downloadedPaths[1] || null,
    };

  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { createAndDownload };
