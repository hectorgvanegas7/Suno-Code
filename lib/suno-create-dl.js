// lib/suno-create-dl.js — Clickea Create en Suno, espera la generación de AMBAS
// versiones y descarga los MP3 a Downloads/suno/.
//
// Flujo real de descarga en Suno:
//   Botón ⋯ (More options) en la card → "Download" → "MP3 Audio"
//   (nunca WAV, nunca opciones Pro)
//
// Bug 1 fix (mini-player): antes de Create, detecta y cierra el mini-player
// flotante de Suno (que tapa el botón). Si no se puede cerrar, JS click directo
// que bypasea z-index. Screenshots diagnósticos en cada intento.
//
// Bug 2 fix (descarga): flujo real ⋯ → Download → MP3 Audio en lugar del
// fetch CDN anterior que no funcionaba.
//
// Bug 3 fix (carpeta): fs.watch sobre Downloads general + Downloads/suno/
// en paralelo. El que recibe el archivo primero gana y lo mueve al destino.
//
// GARANTÍAS:
//   - Nunca clickea más de 2 veces en Create (para no crear canciones extra).
//   - Nunca hace Submit to QA. Nunca toca el Flow.
//   - Si la descarga falla, informa claramente qué falta — no aborta silenciosamente.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { SUNO_DIR, normalize } = require('./audio-match');
const { safeClick, isClickable } = require('./playwright-helpers');

const DEBUG_PORT = 9333;
const GENERATION_TIMEOUT_MS = 8 * 60 * 1000; // 8 minutos
const CREATE_CONFIRM_TIMEOUT_MS = 15000; // esperar a que aparezca una card nueva tras Create
// Suno tarda 2-4 min en generar + tiempo extra para que la descarga aterrice
// en el filesystem. 90s se quedaba corto y tiraba timeout en corridas normales.
const DOWNLOAD_WAIT_TIMEOUT_MS = 8 * 60 * 1000; // 8 minutos (valor original de diseño)
const PROGRESS_LOG_INTERVAL_MS = 30000;

// Carpeta de descargas por defecto del sistema (fallback si CDP redirect falla)
const DEFAULT_DOWNLOADS = path.join(
  process.env.USERPROFILE || process.env.HOME || 'C:/Users/Default',
  'Downloads'
);

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

// Configura el directorio de descarga vía CDP (best-effort: si falla, las
// descargas van a Downloads general y watchForNewMp3 las mueve igual).
async function configureDownloadDir(browser, sunoDir) {
  fs.mkdirSync(sunoDir, { recursive: true });
  try {
    const session = await browser.newBrowserCDPSession();
    await session.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: sunoDir,
      eventsEnabled: true,
    });
    console.log(`  [download] CDP: directorio configurado → ${sunoDir}`);
  } catch (e) {
    console.log(`  [download] CDP Browser.setDownloadBehavior falló (${e.message.split('\n')[0]})`);
    console.log(`  [download] Usando fs.watch como fallback para mover archivos.`);
  }
}

// ─── Bug 1: Mini-player flotante ─────────────────────────────────────────────

// Suno muestra un mini-player fijo en la parte inferior cuando hay una canción
// reproduciéndose. Ese player puede tapar el botón Create con z-index mayor.
// Esta función intenta cerrarlo con selectores conocidos o con Escape.
// Devuelve true si lo cerró, false si no lo encontró (puede que no esté activo).
async function dismissMiniPlayerIfPresent(page) {
  const closeSelectors = [
    '[aria-label="Close player"]',
    '[aria-label="close player" i]',
    '[aria-label="Dismiss player"]',
    '[aria-label="minimize" i]',
    '[aria-label="collapse" i]',
    '[data-testid="close-player"]',
    '[data-testid*="player-close" i]',
    '[class*="player-close" i]',
    '[class*="close"][class*="player" i]',
  ];

  for (const sel of closeSelectors) {
    const btn = page.locator(sel);
    const count = await btn.count();
    if (count > 0 && await btn.first().isVisible().catch(() => false)) {
      console.log(`  [mini-player] Detectado — cerrando con: ${sel}`);
      await btn.first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(700);
      return true;
    }
  }

  // Escape como último recurso (a veces cierra el player en Suno)
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  return false;
}

// ─── Bug (2026-07-01): Panel de Lyrics/Inspo expandido tapa Create ───────────
//
// safeClick venía reportando el bloqueador `div.card-popout-boundary` (texto
// "AudioVoiceNewInspoLyrics[Verse 1]...") — el panel expandido de Lyrics/Inspo
// de Suno, no el mini-player. suno-fill.js ya prueba que el toggle con
// aria-label "Expand lyrics box" abre Y cierra este mismo panel de forma
// confiable (lo usa en cada corrida para el screenshot de verificación y
// vuelve a clickearlo para colapsarlo antes de terminar) — por eso ese toggle
// es el mecanismo primario acá, no una selección a ciegas.
//
// Orden de intento: 1) click en área neutral (afuera del panel, puede
// cerrarlo solo como un dropdown estándar) 2) el toggle "Expand lyrics box"
// (probado en suno-fill.js) o un botón de cerrar genérico dentro del panel
// 3) Escape. Si nada de esto cierra el panel, el caller sigue con
// jsClickCreate como último recurso (bypasea el tapado por completo).
async function dismissLyricsPopoutIfPresent(page) {
  const popout = page.locator('div.card-popout-boundary');
  if ((await popout.count()) === 0) return false;
  if (!(await popout.first().isVisible().catch(() => false))) return false;

  console.log('  [lyrics-popout] Panel de Lyrics/Inspo expandido detectado — cerrando...');

  // 1. Click en área neutral (esquina superior izquierda, lejos del panel)
  await page.mouse.click(10, 10).catch(() => {});
  await page.waitForTimeout(400);
  if (!(await popout.first().isVisible().catch(() => false))) {
    console.log('  [lyrics-popout] Cerrado con click en área neutral.');
    return true;
  }

  // 2a. El mismo toggle que lo abre (probado en suno-fill.js) también lo cierra
  const expandToggle = page.getByLabel('Expand lyrics box');
  if ((await expandToggle.count()) > 0) {
    await expandToggle.first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
    if (!(await popout.first().isVisible().catch(() => false))) {
      console.log('  [lyrics-popout] Cerrado con el toggle "Expand lyrics box".');
      return true;
    }
  }

  // 2b. Fallback genérico: botón de cerrar/collapse dentro del propio panel
  const closeSelectors = [
    '[aria-label="Close" i]',
    '[aria-label="Collapse" i]',
    '[aria-label*="collapse lyrics" i]',
    '[aria-label*="close lyrics" i]',
    'button[class*="close" i]',
  ];
  for (const sel of closeSelectors) {
    const btn = popout.locator(sel);
    if ((await btn.count()) > 0 && await btn.first().isVisible().catch(() => false)) {
      await btn.first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(400);
      if (!(await popout.first().isVisible().catch(() => false))) {
        console.log(`  [lyrics-popout] Cerrado con: ${sel}`);
        return true;
      }
    }
  }

  // 3. Escape como último intento antes de que el caller recurra a jsClickCreate
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const stillOpen = await popout.first().isVisible().catch(() => false);
  if (!stillOpen) console.log('  [lyrics-popout] Cerrado con Escape.');
  return !stillOpen;
}

// Cierra cualquier overlay conocido que pueda tapar el botón Create
// (mini-player, panel de Lyrics/Inspo) y verifica con elementFromPoint que
// Create quedó realmente libre antes de que el caller intente clickearlo.
// Nunca fallar en silencio: si sigue tapado tras reintentar, lo loguea — el
// caller igual sigue con safeClick (que reintenta) y jsClickCreate como último
// recurso.
async function ensureCreateClickable(page, createBtn, label) {
  await dismissMiniPlayerIfPresent(page);
  await dismissLyricsPopoutIfPresent(page);
  await page.waitForTimeout(500);

  if (await isClickable(page, createBtn)) return;

  console.log(`  ⚠️ [${label}] Create sigue tapado tras cerrar overlays conocidos — reintentando cierre...`);
  await dismissMiniPlayerIfPresent(page);
  await dismissLyricsPopoutIfPresent(page);
  await page.waitForTimeout(500);

  if (!(await isClickable(page, createBtn))) {
    console.log(`  ⚠️ [${label}] Create todavía parece tapado — safeClick/jsClickCreate deberán forzarlo.`);
  }
}

// Click directo vía JavaScript — bypasea z-index y pointer-events CSS completamente.
// Último recurso cuando safeClick con force:true también falla.
async function jsClickCreate(page) {
  await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Create song"]') ||
                [...document.querySelectorAll('button')].find((b) => {
                  const text = (b.textContent || '').trim();
                  const aria = b.getAttribute('aria-label') || '';
                  return /create song/i.test(aria) || /^create$/i.test(text);
                });
    if (!btn) throw new Error('No se encontró el botón Create en el DOM para JS click');
    btn.click();
  });
}

// ─── Verificación del formulario ANTES de clickear Create ────────────────────

async function verifyFormBeforeCreate(page) {
  try {
    const lyricsEl = page.locator('[data-testid="lyrics-textarea"]');
    if ((await lyricsEl.count()) === 0) {
      return { ok: false, reason: 'No se encontró el campo de letra [data-testid="lyrics-textarea"]' };
    }

    const lyricsValue = await lyricsEl.inputValue();

    if (/\*\*Advertencias:\*\*/i.test(lyricsValue)) {
      return { ok: false, reason: 'El campo de letra contiene el bloque **Advertencias:** — el parser no lo eliminó. Corregí manualmente.' };
    }

    const sections = ['[Verse 1]', '[Chorus 1]', '[Verse 2]', '[Chorus 2]', '[Bridge]', '[Outro]'];
    const missing = sections.filter((s) => !lyricsValue.includes(s));
    if (missing.length > 0) {
      return { ok: false, reason: `Secciones faltantes en la letra: ${missing.join(', ')}` };
    }

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

// ─── Identificar cards por título (no por posición ni por <audio> global) ────
//
// Suno mantiene canciones viejas en la lista con su audio ya cargado, así que
// contar <audio> globalmente o usar cardIndex fijo termina agarrando canciones
// viejas. En cambio: cada card (`[data-testid="clip-row"]`) tiene un link con
// href único `/song/<uuid>` — un ID estable que no cambia aunque la lista se
// reordene. Anclamos todo a (a) ese href y (b) el título visible normalizado.

// Escanea todas las cards visibles y devuelve título/href/estado "ready" de
// cada una. "ready" = tiene una duración tipo "3:22" renderizada y no tiene
// spinner — antes de eso, Suno no muestra duración fija.
async function scanClipRows(page) {
  return page.evaluate(() => {
    function normalizeInPage(str) {
      return String(str || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    const rows = [...document.querySelectorAll('[data-testid="clip-row"]')];
    return rows
      .map((row) => {
        const a = row.querySelector('a.hover\\:underline');
        const title = a ? a.textContent.trim() : '';
        const href = a ? a.getAttribute('href') : null;
        let duration = null;
        for (const el of row.querySelectorAll('div')) {
          if (el.children.length === 0) {
            const t = (el.textContent || '').trim();
            if (/^\d+:\d{2}$/.test(t)) { duration = t; break; }
          }
        }
        const hasSpinner = !!row.querySelector(
          '[role="progressbar"], [class*="spin" i], [class*="loading" i]'
        );
        return {
          href,
          title,
          normTitle: normalizeInPage(title),
          duration,
          ready: !!duration && !hasSpinner,
        };
      })
      .filter((r) => r.href);
  });
}

// Tras clickear Create, confirma que Suno realmente arrancó la generación:
// espera a que aparezca al menos 1 card cuyo href NO estaba en el snapshot
// previo. Si no aparece ninguna en timeoutMs, el click no funcionó de verdad
// (aunque Playwright no haya lanzado error) — el caller debe reintentar o avisar.
async function waitForCreateStarted(page, existingHrefs, timeoutMs = CREATE_CONFIRM_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await scanClipRows(page);
    const fresh = rows.filter((r) => !existingHrefs.has(r.href));
    if (fresh.length > 0) return fresh;
    await page.waitForTimeout(1000);
  }
  return [];
}

// Espera a que las cards NUEVAS (identificadas por href, no por posición) del
// título actual terminen de generarse. Nunca mira cards viejas aunque compartan
// título (caso REDO con el mismo título). Si una card nueva queda "ready" pero
// con un título distinto al esperado, frena con error — nunca descarga a ciegas.
async function waitForGeneration(page, newHrefSet, normTitle, expectedCount, timeoutMs = GENERATION_TIMEOUT_MS) {
  console.log(`  Esperando que ${expectedCount} versión(es) de "${normTitle}" terminen de generarse...`);
  console.log('  (Esto suele tardar entre 1 y 4 minutos — no cerres Chrome)');

  const startTime = Date.now();
  let lastReady = [];

  while (Date.now() - startTime < timeoutMs) {
    const rows = await scanClipRows(page);
    const candidates = rows.filter((r) => newHrefSet.has(r.href));

    const mismatched = candidates.filter((r) => r.ready && r.normTitle !== normTitle);
    if (mismatched.length > 0) {
      throw new Error(
        `Card nueva con título distinto al esperado — esperaba "${normTitle}", ` +
        `encontré "${mismatched[0].title}" (${mismatched[0].href}). Frenado por seguridad, ` +
        'no se descarga nada automáticamente.'
      );
    }

    const ready = candidates.filter((r) => r.ready && r.normTitle === normTitle);
    lastReady = ready;
    if (ready.length >= expectedCount) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`  ✅ ${ready.length} versión(es) generadas en ${elapsed}s`);
      return ready;
    }
    await page.waitForTimeout(3000);
  }

  return lastReady;
}

// ─── Bug 3: Watcher de filesystem ────────────────────────────────────────────

// Vigila watchDirs (sunoDir Y Downloads general, en paralelo) en cuanto aparece
// un nuevo .mp3 (>50KB) en cualquiera de ellos, lo mueve a destPath y resuelve.
// Funciona independientemente de si CDP redirigió las descargas o no.
// El caller debe invocar esto ANTES de disparar la descarga (click en "MP3
// Audio"), para no perder el evento de filesystem si el archivo aterriza rápido.
function watchForNewMp3(watchDirs, destPath, timeoutMs = DOWNLOAD_WAIT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let done = false;
    const watchers = [];
    const startTime = Date.now();

    // Snapshot de archivos existentes ANTES de disparar la descarga
    const snapshots = {};
    for (const dir of watchDirs) {
      fs.mkdirSync(dir, { recursive: true });
      try {
        snapshots[dir] = new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.mp3')));
      } catch {
        snapshots[dir] = new Set();
      }
    }

    function finish(srcPath) {
      if (done) return;
      done = true;
      watchers.forEach((w) => { try { w.close(); } catch {} });
      clearInterval(pollTimer);
      clearInterval(progressTimer);
      clearTimeout(deadline);

      const resolvedSrc = path.resolve(srcPath);
      const resolvedDest = path.resolve(destPath);

      if (resolvedSrc === resolvedDest) {
        resolve(destPath);
        return;
      }

      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      try {
        fs.renameSync(srcPath, destPath);
      } catch {
        try {
          fs.copyFileSync(srcPath, destPath);
          try { fs.unlinkSync(srcPath); } catch {}
        } catch (e2) {
          reject(new Error(`No se pudo mover ${srcPath} → ${destPath}: ${e2.message}`));
          return;
        }
      }
      resolve(destPath);
    }

    function checkDir(dir) {
      if (done) return;
      try {
        const files = fs.readdirSync(dir);
        const newMp3s = files.filter((f) => f.endsWith('.mp3') && !snapshots[dir].has(f));
        for (const f of newMp3s) {
          const fullPath = path.join(dir, f);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size > 50000) { // >50KB = descarga completa
              finish(fullPath);
              return;
            }
          } catch {}
        }
      } catch {}
    }

    for (const dir of watchDirs) {
      const w = fs.watch(dir, (event, filename) => {
        if (filename && filename.endsWith('.mp3')) {
          setTimeout(() => checkDir(dir), 1500);
        }
      });
      w.on('error', () => {});
      watchers.push(w);
    }

    const pollTimer = setInterval(() => {
      for (const dir of watchDirs) checkDir(dir);
    }, 3000);

    // Log de progreso — para que Gabo sepa que el script sigue vivo (no colgado)
    // durante los 2-4 min que Suno tarda en generar + el tiempo de descarga.
    const progressTimer = setInterval(() => {
      if (done) return;
      const elapsedS = Math.round((Date.now() - startTime) / 1000);
      const min = Math.floor(elapsedS / 60);
      const s = elapsedS % 60;
      console.log(`  ⏳ Esperando MP3... ${min}min ${s}s transcurridos`);
    }, PROGRESS_LOG_INTERVAL_MS);

    const deadline = setTimeout(() => {
      if (done) return;
      done = true;
      watchers.forEach((w) => { try { w.close(); } catch {} });
      clearInterval(pollTimer);
      clearInterval(progressTimer);
      reject(new Error(
        `Timeout ${timeoutMs}ms esperando MP3 en: ${watchDirs.join(', ')}`
      ));
    }, timeoutMs);
  });
}

// ─── Bug 2: Descarga vía menú ⋯ → Download → MP3 Audio ──────────────────────

// Descarga la canción de la card identificada por su href único (/song/<uuid>)
// usando el flujo real de Suno: botón ⋯ → "Download" → "MP3 Audio".
// NUNCA elige WAV. NUNCA elige opciones Pro.
// Localiza la card por href (no por índice global) para no depender de la
// posición ni de que otra card se haya insertado/reordenado entre medio.
// Inicia el watcher de filesystem ANTES de abrir el menú para no perder el evento.
async function downloadVia3DotMenu(page, href, label, sunoDir, destPath) {
  // Iniciar watcher ANTES de clickear el menú (para no perder el evento de descarga)
  const watchDirs = [sunoDir];
  if (path.resolve(DEFAULT_DOWNLOADS) !== path.resolve(sunoDir)) {
    watchDirs.push(DEFAULT_DOWNLOADS);
  }
  const downloadPromise = watchForNewMp3(watchDirs, destPath, DOWNLOAD_WAIT_TIMEOUT_MS);

  // ─── Encontrar la card por href y el botón ⋯ dentro de ELLA ──────────────
  const row = page.locator('[data-testid="clip-row"]').filter({
    has: page.locator(`a[href="${href}"]`),
  }).first();

  if ((await row.count()) === 0) {
    downloadPromise.catch(() => {});
    throw new Error(`No se encontró la card con href "${href}" para descargar la versión ${label}.`);
  }

  const moreBtn = row.locator('[aria-label="More options"]').first();
  if ((await moreBtn.count()) === 0) {
    downloadPromise.catch(() => {});
    throw new Error(`No se encontró el botón ⋯ dentro de la card "${href}" (versión ${label}).`);
  }

  await safeClick(page, moreBtn, { label: `⋯ (versión ${label})`, maxAttempts: 3 });
  await page.waitForTimeout(600);

  // ─── "Download" en el menú contextual ────────────────────────────────────
  const downloadItem = page.locator('[role="menuitem"]').filter({ hasText: /^download$/i })
    .or(page.getByRole('menuitem', { name: /^download$/i }))
    .or(page.getByText('Download', { exact: true }))
    .first();

  try {
    await downloadItem.waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    await page.keyboard.press('Escape');
    throw new Error(`El menú ⋯ no mostró la opción "Download" para versión ${label}`);
  }

  await safeClick(page, downloadItem, { label: 'Download (menú)', maxAttempts: 3 });
  await page.waitForTimeout(500);

  // ─── "MP3 Audio" en el submenú ───────────────────────────────────────────
  // NUNCA clickear WAV ni opciones que contengan "Pro" o "Lossless"
  const mp3Item = page.locator('[role="menuitem"]').filter({ hasText: /mp3\s*audio/i })
    .or(page.getByRole('menuitem', { name: /mp3\s*audio/i }))
    .or(page.getByText('MP3 Audio', { exact: true }))
    .first();

  try {
    await mp3Item.waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    // Tomar screenshot del estado actual para diagnóstico
    await page.screenshot({ path: `suno-dl-submenu-${label}.png` }).catch(() => {});
    await page.keyboard.press('Escape');
    throw new Error(
      `El submenú no mostró "MP3 Audio" para versión ${label}. ` +
      `Screenshot: suno-dl-submenu-${label}.png`
    );
  }

  // Verificar que no estamos clickeando WAV accidentalmente
  const mp3Text = await mp3Item.textContent().catch(() => '');
  if (/wav|lossless|pro/i.test(mp3Text) && !/mp3/i.test(mp3Text)) {
    await page.keyboard.press('Escape');
    throw new Error(`El item de menú seleccionado no es MP3: "${mp3Text}" — cancelado por seguridad`);
  }

  await safeClick(page, mp3Item, {
    label: 'MP3 Audio (submenú)',
    maxAttempts: 3,
    allowForce: false, // no forzar en submenús — si falla es ambiguo
  });

  console.log(`  [dl] Click en "MP3 Audio". Esperando descarga en ${watchDirs.join(' / ')}...`);

  // ─── Esperar que el archivo aparezca en el filesystem ────────────────────
  const finalPath = await downloadPromise;
  const stat = fs.statSync(finalPath);
  console.log(`  ✅ Versión descargada: ${path.basename(finalPath)} (${Math.round(stat.size / 1024)} KB)`);
  return finalPath;
}

// ─── Punto de entrada público ─────────────────────────────────────────────────

// Conecta al Chrome de Suno, verifica el formulario, clickea Create (×2),
// espera generación y descarga ambos MP3 vía menú ⋯ → Download → MP3 Audio.
// Devuelve { versionA, versionB } con rutas locales. Lanza si no puede recuperar.
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

    // CDP redirect (best-effort — fs.watch es el mecanismo real)
    await configureDownloadDir(browser, sunoDir);

    // 2. Cerrar overlays que puedan tapar Create (mini-player, panel de Lyrics/Inspo)
    console.log('  Verificando overlays (mini-player / Lyrics-Inspo) antes de Create...');
    await dismissMiniPlayerIfPresent(page);
    await page.waitForTimeout(300);

    // Snapshot ANTES de Create: cualquier card cuyo href no esté acá es nueva.
    const normTitle = normalize(verify.titulo);
    const baselineRows = await scanClipRows(page);
    const existingHrefs = new Set(baselineRows.map((r) => r.href));

    // 3. Click Create × 2 (Suno genera 2 versiones por canción)
    const createBtn = page.getByRole('button', { name: 'Create song', exact: true })
      .or(page.locator('button[aria-label="Create song"]'))
      .first();
    await createBtn.waitFor({ state: 'visible', timeout: 15000 });

    await ensureCreateClickable(page, createBtn, 'Create #1');

    console.log('  Click #1 en Create...');
    await safeClick(page, createBtn, {
      label: 'Create (1er click)',
      maxAttempts: 5,
      waitMs: 600,
      screenshotPrefix: 'suno-create-click1',
    }).catch(async (safeClickErr) => {
      // safeClick agotó intentos — JS click como último recurso (bypasea z-index)
      console.log(`  [Create] safeClick falló: ${safeClickErr.message.split('\n')[0]}`);
      console.log('  [Create] Intentando JS click directo (bypasea z-index)...');
      await jsClickCreate(page);
      console.log('  [Create] JS click ejecutado.');
    });

    // Confirmar que el click #1 REALMENTE arrancó una generación — nunca dar
    // por hecho que clickear (aunque Playwright no haya lanzado error) generó
    // algo. Si no aparece ninguna card nueva, reintentar con JS click antes de
    // rendirse.
    let fresh = await waitForCreateStarted(page, existingHrefs);
    if (fresh.length === 0) {
      console.log('  ⚠️ No apareció ninguna card nueva tras el click #1. Reintentando con JS click...');
      await jsClickCreate(page).catch(() => {});
      fresh = await waitForCreateStarted(page, existingHrefs);
    }
    if (fresh.length === 0) {
      await page.screenshot({ path: 'suno-create-no-card-detected.png' }).catch(() => {});
      throw new Error(
        'El click en Create no generó ninguna canción nueva detectable tras ' +
        `${CREATE_CONFIRM_TIMEOUT_MS / 1000}s (dos intentos). Screenshot: ` +
        'suno-create-no-card-detected.png. Clickeá Create manualmente y reintentá.'
      );
    }
    console.log(`  ✅ Primer Create confirmado (${fresh.length} card(s) nueva(s) detectada(s)).`);

    // Esperar a que el botón vuelva a estar activo para el segundo click
    await page.waitForTimeout(1500);
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('button[aria-label="Create song"]') ||
                    [...document.querySelectorAll('button')].find((b) =>
                      /create song/i.test(b.getAttribute('aria-label') || '')
                    );
        return btn && !btn.disabled && !btn.getAttribute('aria-disabled') && !btn.hasAttribute('data-disabled');
      },
      { timeout: 10000 }
    ).catch(() => {});

    await ensureCreateClickable(page, createBtn, 'Create #2');

    console.log('  Click #2 en Create...');
    await safeClick(page, createBtn, {
      label: 'Create (2do click)',
      maxAttempts: 5,
      waitMs: 600,
      screenshotPrefix: 'suno-create-click2',
    }).catch(async (safeClickErr2) => {
      // Intentar JS click primero
      console.log(`  [Create #2] safeClick falló: ${safeClickErr2.message.split('\n')[0]}`);
      await jsClickCreate(page).catch((jsErr) => {
        // Si JS click también falla, es probable que el botón ya no esté —
        // la canción ya se inició con el primer click
        console.log(`  [Create #2] JS click también falló: ${jsErr.message.split('\n')[0]}`);
        console.log('  La canción se inició solo con el primer click.');
      });
    });

    // Confirmar el click #2: esperar a que el TOTAL de cards nuevas (relativo
    // al baseline) llegue a 2. Si se queda en 1, seguimos con 1 (como antes)
    // pero SIEMPRE anclado a hrefs nuevos, nunca a cards viejas.
    fresh = await waitForCreateStarted(page, existingHrefs);
    if (fresh.length >= 2) {
      console.log('  ✅ Segundo Create confirmado (2 cards nuevas detectadas).');
    } else {
      console.log('  ⚠️ Solo se detectó 1 card nueva tras el segundo click. Se continúa con 1 versión.');
    }

    await page.screenshot({ path: 'suno-after-create.png' });

    // Fijar el set final de hrefs nuevos (máx 2), en el orden en que aparecen
    // en el DOM (Suno inserta las nuevas arriba de todo, orden estable).
    const newHrefSet = new Set(fresh.slice(0, 2).map((r) => r.href));

    // 4. Esperar que las canciones NUEVAS (por href + título, nunca las viejas)
    // terminen de generarse.
    const readyCards = await waitForGeneration(page, newHrefSet, normTitle, newHrefSet.size, GENERATION_TIMEOUT_MS);
    if (readyCards.length === 0) {
      throw new Error(
        `Timeout esperando generación de "${verify.titulo}" (${GENERATION_TIMEOUT_MS / 60000} min). ` +
        'Verificá el estado de Suno en el navegador.'
      );
    }
    if (readyCards.length < newHrefSet.size) {
      console.log(`  ⚠️ Solo ${readyCards.length}/${newHrefSet.size} versión(es) terminaron de generarse en el tiempo esperado.`);
    }

    // Cerrar el mini-player nuevamente antes de descargar — puede tapar el
    // botón ⋯ con z-index.
    await dismissMiniPlayerIfPresent(page);
    await page.waitForTimeout(500);

    await page.screenshot({ path: 'suno-before-download.png' });

    // 5. Descargar cada MP3 vía menú ⋯ → Download → MP3 Audio, localizando
    // cada card por su href (nunca por índice/posición).
    const slug = slugify(verify.titulo);
    const now = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const versionLabels = ['A', 'B'];

    const downloadedPaths = [];
    for (let i = 0; i < readyCards.length; i++) {
      const versionLabel = versionLabels[i];
      const destPath = path.join(sunoDir, `${dateStr}-${slug}-${versionLabel}.mp3`);

      console.log(`\n  Descargando Versión ${versionLabel} (⋯ → Download → MP3 Audio) — "${readyCards[i].title}"...`);
      try {
        await downloadVia3DotMenu(page, readyCards[i].href, versionLabel, sunoDir, destPath);
        downloadedPaths.push({ label: versionLabel, path: destPath });
        // Pausa entre descargas para que el menú se cierre completamente
        await page.waitForTimeout(1500);
      } catch (e) {
        console.log(`  ❌ No se pudo descargar la Versión ${versionLabel}: ${e.message}`);
        console.log(`     Descargala manualmente: botón ⋯ de la canción "${verify.titulo}" → Download → MP3 Audio`);
        console.log(`     Guardala en: ${sunoDir}`);
      }
    }

    if (downloadedPaths.length === 0) {
      throw new Error(
        'No se pudo descargar ninguna versión automáticamente. ' +
        'Descargalas manualmente: botón ⋯ → Download → MP3 Audio para cada canción.'
      );
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
