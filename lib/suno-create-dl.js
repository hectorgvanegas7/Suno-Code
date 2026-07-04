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
// ⚠️ NO reintroducir descarga por interceptación de red / fetch de la URL de
// audio (visto en el repo el 2026-07-03, ya retirado): un <a download> hacia
// una URL cross-origin sin Content-Disposition: attachment del lado del
// servidor no garantiza que el navegador guarde el archivo — es exactamente
// el mismo problema ya documentado y descartado el 2026-06-30 (ver
// LESSONS.md, "Flujo de descarga de Suno no tiene botón directo"). Además,
// como comparte el mismo watcher/timeout de watchForNewMp3 con el flujo
// visual, si el bypass se cuelga hasta agotar el deadline, el fallback
// visual nunca llega a intentarse con una ventana real (el watcher ya está
// consumido/cerrado). El único mecanismo soportado es el menú visual de
// abajo — es lento pero confiable con el timeout correcto (8 min).
//
// GARANTÍAS:
//   - Clickea Create UNA SOLA VEZ (Suno v5.5 genera 2 versiones por click).
//   - Nunca hace Submit to QA. Nunca toca el Flow.
//   - Si la descarga falla, informa claramente qué falta — no aborta silenciosamente.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { SUNO_DIR, normalize } = require('./audio-match');
const { safeClick, isClickable, pauseForHumanInteraction, connectToSunoTab } = require('./playwright-helpers');
const {
  LYRICS_TEXTAREA,
  TITLE_INPUT,
  EXPAND_LYRICS_BOX_LABEL,
  CREATE_SONG_ROLE_NAME,
  CREATE_SONG_ARIA_SELECTOR,
  MORE_OPTIONS_MENU_ARIA_SELECTOR,
  CLIP_ROW,
} = require('./suno-selectors');

const DEBUG_PORT = 9333;
const GENERATION_TIMEOUT_MS = 25 * 60 * 1000; // 25 minutos
// Suno v5.5 genera 2 versiones con UN SOLO click en Create, pero la 2da card
// puede aparecer un instante después de la 1ra — esperamos hasta este tiempo
// a que aparezcan hasta 2 hrefs nuevos antes de conformarnos con 1.
const CREATE_CARDS_TIMEOUT_MS = 20000;
// Tiempo máximo para esperar la DESCARGA del archivo MP3 una vez que se hace
// click. 8 min es el valor de diseño original (ver LESSONS.md, 2026-07-01:
// "Timeout de 90s esperando MP3 era demasiado corto para generación real") —
// una edición externa lo había bajado a 3 min (2026-07-03), reintroduciendo
// el mismo bug: la descarga real (confirmada con el archivo en disco) tardó
// más de 3 min y el código la dio por perdida antes de que terminara.
const DOWNLOAD_WAIT_TIMEOUT_MS = 8 * 60 * 1000; // 8 minutos
const PROGRESS_LOG_INTERVAL_MS = 30000;

// Carpeta de descargas por defecto del sistema (fallback si CDP redirect falla)
const DEFAULT_DOWNLOADS = path.join(
  process.env.USERPROFILE || process.env.HOME || 'C:/Users/Default',
  'Downloads'
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Si destPath ya existe (dos canciones con el mismo título saneado — el
// nombre "limpio" ya no lleva fecha para desambiguar), no lo pisa en
// silencio: agrega " (2)", " (3)", etc. hasta encontrar uno libre.
function getUniqueDestPath(destPath) {
  if (!fs.existsSync(destPath)) return destPath;
  const dir = path.dirname(destPath);
  const base = path.basename(destPath, '.mp3');
  let n = 2;
  let candidate;
  do {
    candidate = path.join(dir, `${base} (${n}).mp3`);
    n++;
  } while (fs.existsSync(candidate));
  return candidate;
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
  const expandToggle = page.getByLabel(EXPAND_LYRICS_BOX_LABEL);
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
  await page.evaluate((ariaSelector) => {
    const btn = document.querySelector(ariaSelector) ||
                [...document.querySelectorAll('button')].find((b) => {
                  const text = (b.textContent || '').trim();
                  const aria = b.getAttribute('aria-label') || '';
                  return /create song/i.test(aria) || /^create$/i.test(text);
                });
    if (!btn) throw new Error('No se encontró el botón Create en el DOM para JS click');
    btn.click();
  }, CREATE_SONG_ARIA_SELECTOR);
}

// ─── Verificación del formulario y créditos ANTES de clickear Create ───────────

async function checkSunoCredits(page) {
  try {
    // Buscar un span/div que tenga la palabra "credits" o el icono de créditos.
    // Usualmente Suno lo tiene como un badge en el topbar, ej: "1050 credits"
    const creditsEl = page.getByText(/credits?/i).first();
    const isVisible = await creditsEl.isVisible();
    if (isVisible) {
      const text = await creditsEl.innerText();
      const match = text.match(/([\d,]+)/);
      if (match) {
        const credits = parseInt(match[1].replace(/,/g, ''), 10);
        console.log(`  💰 Créditos Suno disponibles: ${credits}`);
        if (credits < 10) {
          console.warn(`\n  ⚠️ ADVERTENCIA CRÍTICA: Tienes muy pocos créditos en Suno (${credits}). La generación va a fallar.`);
          const { notify } = require('./ntfy');
          await notify(`⚠️ Te quedaste sin créditos en Suno (${credits} restantes)`, { title: 'Cancion Eterna', priority: 'high', tags: 'money_with_wings' }).catch(() => {});
          await pauseForHumanInteraction(`Tienes ${credits} créditos. Necesitas al menos 10. Compra más créditos en Suno y presiona ENTER para continuar.`);
        }
      }
    } else {
      console.log(`  (No se pudo leer el saldo de créditos, omitiendo verificación)`);
    }
  } catch (e) {
    console.log(`  (Error leyendo saldo de créditos: ${e.message})`);
  }
}

async function verifyFormBeforeCreate(page) {
  try {
    const lyricsEl = page.locator(LYRICS_TEXTAREA).first();
    if ((await lyricsEl.count()) === 0) {
      return { ok: false, reason: `No se encontró el campo de letra ${LYRICS_TEXTAREA}` };
    }

    const lyricsValue = await lyricsEl.evaluate(el => el.value !== undefined ? el.value : el.innerText).catch(() => '');

    if (/\*\*Advertencias:\*\*/i.test(lyricsValue)) {
      return { ok: false, reason: 'El campo de letra contiene el bloque **Advertencias:** — el parser no lo eliminó. Corregí manualmente.' };
    }

    const sections = ['[Verse 1]', '[Chorus 1]', '[Verse 2]', '[Chorus 2]', '[Bridge]', '[Outro]'];
    const missing = sections.filter((s) => !lyricsValue.includes(s));
    if (missing.length > 0) {
      return { ok: false, reason: `Secciones faltantes en la letra: ${missing.join(', ')}` };
    }

    const titleInputs = page.locator(TITLE_INPUT);
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
// MIN_READY_DURATION_SEC: una card generando muestra transitoriamente "0:00"
// (que matchea /^\d+:\d{2}$/), y nuestras canciones duran 2:45–3:30. Cualquier
// duración por debajo de este piso es placeholder, NO una canción terminada.
const MIN_READY_DURATION_SEC = 45;

async function scanClipRows(page) {
  return page.evaluate(({ minReadySec, clipRowSelector }) => {
    function normalizeInPage(str) {
      return String(str || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    function toSeconds(mmss) {
      const m = /^(\d+):(\d{2})$/.exec(mmss);
      if (!m) return null;
      return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    }
    const rows = [...document.querySelectorAll(clipRowSelector)];
    return rows
      .map((row) => {
        const a = row.querySelector('a.hover\\:underline');
        const title = a ? a.textContent.trim() : '';
        const href = a ? a.getAttribute('href') : null;

        // Buscar TODAS las duraciones tipo mm:ss en divs hoja y quedarnos con
        // la mayor (la card lista muestra la duración real; un "0:00" residual
        // no debe ganarle a "3:22").
        let durationSec = null;
        let duration = null;
        for (const el of row.querySelectorAll('div')) {
          if (el.children.length === 0) {
            const t = (el.textContent || '').trim();
            if (/^\d+:\d{2}$/.test(t)) {
              const secs = toSeconds(t);
              if (secs != null && (durationSec == null || secs > durationSec)) {
                durationSec = secs;
                duration = t;
              }
            }
          }
        }

        // Señales de "todavía generando": spinner/progressbar, aria-busy, o
        // texto de estado ("Creating", "Generating", "Queued", "%").
        const hasSpinner = !!row.querySelector(
          '[role="progressbar"], [aria-busy="true"], [class*="spin" i], [class*="loading" i], [class*="pulse" i]'
        );
        const rowText = (row.textContent || '');
        const hasGeneratingText = /\b(creating|generating|queued|pending|loading)\b|\d+\s*%/i.test(rowText);

        const hasRealDuration = durationSec != null && durationSec >= minReadySec;

        return {
          href,
          title,
          normTitle: normalizeInPage(title),
          duration,
          durationSec,
          // "ready" = tiene una duración REAL (>= piso) y ninguna señal de que
          // siga generando. El caller además exige estabilidad + piso de tiempo.
          ready: hasRealDuration && !hasSpinner && !hasGeneratingText,
        };
      })
      .filter((r) => r.href);
  }, { minReadySec: MIN_READY_DURATION_SEC, clipRowSelector: CLIP_ROW });
}

// Tras clickear Create, confirma que Suno realmente arrancó la generación y
// recolecta hasta 2 hrefs nuevos (Suno v5.5 genera 2 versiones con un solo
// click; la 2da card puede aparecer un instante después de la 1ra). Devuelve
// apenas hay 2, o lo que haya juntado al agotar timeoutMs (0, 1 o más si algo
// clickeó de más) — el caller decide qué hacer con cada caso.
async function waitForCreateStarted(page, existingHrefs, timeoutMs = CREATE_CARDS_TIMEOUT_MS) {
  const start = Date.now();
  let fresh = [];
  while (Date.now() - start < timeoutMs) {
    const rows = await scanClipRows(page);
    fresh = rows.filter((r) => !existingHrefs.has(r.href));
    if (fresh.length >= 2) return fresh;
    await page.waitForTimeout(1000);
  }
  return fresh;
}

// Espera a que las cards NUEVAS (identificadas por href, no por posición) del
// título actual terminen de generarse. Nunca mira cards viejas aunque compartan
// título (caso REDO con el mismo título). Si una card nueva queda "ready" pero
// con un título distinto al esperado, frena con error — nunca descarga a ciegas.
// Piso de tiempo: Suno físicamente no termina en 0s. Nunca aceptamos "listo"
// antes de esto, sin importar lo que diga el DOM (mata el falso "generadas en 0s").
const MIN_GENERATION_FLOOR_MS = 20000;
// Estabilidad: una card debe seguir "ready" con la MISMA duración en 2 escaneos
// consecutivos antes de darla por buena (evita atrapar un valor transitorio).
const STABILITY_POLLS = 2;

async function waitForGeneration(page, newHrefSet, normTitle, expectedCount, timeoutMs = GENERATION_TIMEOUT_MS) {
  console.log(`  Esperando que ${expectedCount} versión(es) de "${normTitle}" terminen de generarse...`);
  console.log('  (Esto suele tardar entre 1 y 4 minutos — no cerres Chrome)');

  const startTime = Date.now();
  let lastReady = [];
  const stable = new Map(); // href -> { durationSec, count, row }

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

    // Actualizar el contador de estabilidad por href.
    for (const r of candidates) {
      if (r.ready && r.normTitle === normTitle) {
        const prev = stable.get(r.href);
        if (prev && prev.durationSec === r.durationSec) {
          prev.count += 1;
        } else {
          stable.set(r.href, { durationSec: r.durationSec, count: 1, row: r });
        }
        if (stable.has(r.href)) stable.get(r.href).row = r;
      } else {
        stable.delete(r.href); // volvió a "no listo" → reiniciar
      }
    }

    const elapsed = Date.now() - startTime;
    const readyStable = candidates.filter((r) => {
      const s = stable.get(r.href);
      return s && s.count >= STABILITY_POLLS;
    });
    lastReady = readyStable;

    // Sólo declarar completo si además pasó el piso de tiempo.
    if (readyStable.length >= expectedCount && elapsed >= MIN_GENERATION_FLOOR_MS) {
      const secs = Math.round(elapsed / 1000);
      console.log(`  ✅ ${readyStable.length} versión(es) generadas y estables en ${secs}s`);
      return readyStable;
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
//
// Devuelve { promise, cancel }. IMPORTANTE: si el flujo de descarga falla antes
// de que el archivo aterrice, el caller DEBE llamar cancel() para no dejar un
// watcher huérfano cuya promesa rechace a los 8 min (unhandled rejection que
// tumbaba el proceso — ver log del 2026-07-01). cancel() cierra todo y resuelve
// la promesa con null en vez de rechazar, así nunca queda un reject sin catch.
function watchForNewMp3(watchDirs, destPath, timeoutMs = DOWNLOAD_WAIT_TIMEOUT_MS) {
  let cancelFn = () => {};
  const promise = new Promise((resolve, reject) => {
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

    function cleanup() {
      watchers.forEach((w) => { try { w.close(); } catch {} });
      clearInterval(pollTimer);
      clearInterval(progressTimer);
      clearTimeout(deadline);
    }

    function finish(srcPath) {
      if (done) return;
      done = true;
      cleanup();

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

    // Cancelación limpia: resuelve con null (no rechaza) para que un watcher
    // abandonado nunca produzca una unhandled rejection.
    cancelFn = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve(null);
    };

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
      cleanup();
      reject(new Error(
        `Timeout ${timeoutMs}ms esperando MP3 en: ${watchDirs.join(', ')}`
      ));
    }, timeoutMs);
  });

  return { promise, cancel: () => cancelFn() };
}

// ─── Bug 2: Descarga vía menú ⋯ → Download → MP3 Audio ──────────────────────

// Abre el menú ⋯ de la card (por href) y navega Download → MP3 Audio.
// "Download" es un SUBMENÚ de Radix (flecha ▸): se abre con HOVER, no con
// click — clickearlo puede cerrar el menú entero. Por eso hover + poll de
// "MP3 Audio".
// Devuelve:
//   'clicked'   → se clickeó MP3 Audio (la descarga debería dispararse)
//   'not-ready' → el menú abrió pero NO apareció "MP3 Audio" (audio aún no
//                 renderizado — toast "preparing your mp3...", o glitch del
//                 flyout) → el caller debe esperar y reintentar, nunca
//                 tratarlo como fallo permanente.
//   'no-menu'   → no se pudo ni abrir el ⋯ / la card no está (fallo estructural)
async function tryOpenDownloadMp3(page, href, label) {
  // Cerrar cualquier menú abierto de un intento previo
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);

  const row = page.locator(CLIP_ROW).filter({
    has: page.locator(`a[href="${href}"]`),
  }).first();
  if ((await row.count()) === 0) return 'no-menu';

  const moreBtn = row.locator(MORE_OPTIONS_MENU_ARIA_SELECTOR).first();
  if ((await moreBtn.count()) === 0) return 'no-menu';

  await safeClick(page, moreBtn, { label: `⋯ (versión ${label})`, maxAttempts: 3 });
  await page.waitForTimeout(500);

  // "Download" (subtrigger del menú contextual). Verificado en vivo
  // (2026-07-02): el menú de Suno ya NO usa role="menuitem" — son botones
  // planos (`hxc-btn-*`), y el trigger "Download" no tiene aria-label propio
  // (a diferencia de sus opciones), así que se identifica por su texto visible.
  const downloadItem = page.getByRole('button', { name: 'Download', exact: true })
    .or(page.locator('button').filter({ hasText: /^download$/i }))
    .first();
  try {
    await downloadItem.waitFor({ state: 'visible', timeout: 4000 });
  } catch {
    await page.keyboard.press('Escape').catch(() => {});
    return 'no-menu';
  }

  // MP3 Audio vive dentro del flyout del submenú. A diferencia de "Download",
  // SÍ tiene su propio aria-label exacto — selector directo, más robusto que
  // buscar por rol/texto (verificado en vivo, 2026-07-02).
  const mp3Item = page.locator('button[aria-label="MP3 Audio"]')
    .or(page.getByRole('button', { name: 'MP3 Audio', exact: true }))
    .first();

  // Abrir el submenú con HOVER y esperar a que aparezca MP3 Audio. Reintentar
  // el hover un par de veces (Radix a veces necesita re-entrar el pointer), y
  // como red de seguridad probar navegación por teclado y click en el subtrigger.
  const HOVER_ATTEMPTS = 3;
  for (let h = 1; h <= HOVER_ATTEMPTS; h++) {
    await downloadItem.hover().catch(() => {});
    await page.waitForTimeout(500);
    if (await mp3Item.count() > 0 && await mp3Item.first().isVisible().catch(() => false)) {
      break;
    }
    // Optimización de ejecución AGY: Fallback de teclado para Radix UI (muy robusto si falla el puntero)
    await downloadItem.focus().catch(() => {});
    await page.keyboard.press('ArrowRight').catch(() => {});
    await page.waitForTimeout(500);
    if (await mp3Item.count() > 0 && await mp3Item.first().isVisible().catch(() => false)) {
      break;
    }
    // Fallback: algunos builds abren el submenú con click en el subtrigger
    if (h === HOVER_ATTEMPTS) {
      await downloadItem.click().catch(() => {});
      await page.waitForTimeout(500);
    }
  }

  // Poll final por MP3 Audio (hasta 3s más) — cubre el render tardío del flyout
  let mp3Visible = false;
  for (let i = 0; i < 6; i++) {
    if (await mp3Item.count() > 0 && await mp3Item.first().isVisible().catch(() => false)) {
      mp3Visible = true;
      break;
    }
    // Mantener el submenú abierto re-hovereando el subtrigger
    await downloadItem.hover().catch(() => {});
    await page.waitForTimeout(500);
  }

  if (!mp3Visible) {
    await page.screenshot({ path: `suno-dl-submenu-${label}.png` }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    return 'not-ready';
  }

  // Salvaguarda: no clickear WAV/Pro/Lossless por error
  const mp3Text = await mp3Item.first().textContent().catch(() => '');
  if (/wav|lossless/i.test(mp3Text) && !/mp3/i.test(mp3Text)) {
    await page.keyboard.press('Escape').catch(() => {});
    return 'not-ready';
  }

  // Hover primero (entra el pointer al flyout, lo mantiene abierto) y luego click
  await mp3Item.first().hover().catch(() => {});
  await page.waitForTimeout(150);
  await mp3Item.first().click({ timeout: 4000 }).catch(async () => {
    // último recurso: click forzado
    await mp3Item.first().click({ force: true }).catch(() => {});
  });
  return 'clicked';
}

// Fase 1 de la descarga: clickea ⋯ → Download → MP3 Audio en la card (por
// href), reintentando hasta deadlineMs. NUNCA WAV, NUNCA Pro. La fuente de
// verdad de "listo para descargar" es que "MP3 Audio" exista en el submenú:
// si no está (toast "preparing your mp3..."), no se fuerza nada — se espera y
// se reintenta. Localiza la card por href (nunca por índice global).
// Devuelve true si logró clickear (la descarga debería estar disparándose),
// false si agotó el tiempo sin lograrlo (fallo "blando" — el caller decide si
// cae al fallback manual). Solo LANZA ante un fallo estructural (la card o el
// ⋯ desaparecieron del DOM 3 veces seguidas) — no tiene sentido seguir
// esperando ahí.
async function clickDownloadMp3(page, href, label, deadlineMs) {
  const start = Date.now();
  let attempt = 0;

  // Flujo visual: ⋯ → Download → MP3 Audio (el único mecanismo — ver nota
  // en el header del archivo sobre por qué no hay bypass de red).
  while (Date.now() - start < deadlineMs) {
    attempt++;
    const result = await tryOpenDownloadMp3(page, href, label);

    if (result === 'clicked') {
      console.log(`  [dl] Click en "MP3 Audio" (versión ${label}, intento ${attempt}).`);
      return true;
    }

    if (result === 'no-menu') {
      // Fallo estructural: la card o el ⋯ no están. Reintentar unas pocas
      // veces por si la lista se re-renderizó; si persiste, abortar.
      if (attempt >= 3) {
        throw new Error(`No se pudo abrir el menú ⋯ de la card "${href}" (versión ${label}) tras ${attempt} intentos.`);
      }
      await page.waitForTimeout(2000);
      continue;
    }

    // result === 'not-ready': MP3 Audio aún no disponible (toast "preparing
    // your mp3...") → esperar y reintentar
    const waited = Math.round((Date.now() - start) / 1000);
    console.log(`  [dl] "MP3 Audio" todavía no disponible para versión ${label} (${waited}s). Esperando render y reintentando...`);
    await page.waitForTimeout(5000);
  }
  return false;
}

// Fase 2 de la descarga (versión que SÍ se clickeó): espera a que el archivo
// aterrice sobre un watcher ya corriendo. Pensada para correr en PARALELO
// entre A y B (Promise.allSettled en el caller) — a diferencia del fallback
// manual de abajo, acá no hay ningún recurso compartido (stdin) que impida
// que ambas esperas convivan.
async function awaitClickedDownload(watcher, label) {
  try {
    const finalPath = await watcher.promise;
    if (!finalPath) {
      // watcher fue cancelado desde afuera (no debería pasar acá) — tratar como fallo
      throw new Error(`Descarga de versión ${label} cancelada antes de completarse.`);
    }
    const stat = fs.statSync(finalPath);
    console.log(`  ✅ Versión ${label} descargada: ${path.basename(finalPath)} (${Math.round(stat.size / 1024)} KB)`);
    return finalPath;
  } catch (e) {
    watcher.cancel(); // CLAVE: nunca dejar el watcher huérfano (evita el crash por unhandled rejection)
    throw e;
  }
}

// Fase 2 de la descarga (versión que NO se logró clickear): fallback manual.
// Deliberadamente SECUENCIAL en el caller (nunca en paralelo con otra llamada
// a este mismo helper) — pauseForHumanInteraction escucha 'data' en
// process.stdin sin distinguir de qué llamada es, así que dos esperas
// manuales corriendo a la vez harían que un solo ENTER resuelva ambas de
// golpe, aunque el humano solo haya terminado una descarga.
async function awaitManualDownload(watcher, label) {
  try {
    console.warn(`  ⚠️ Falló la descarga visual para la versión ${label}.`);
    const ac = new AbortController();
    const finalPath = await Promise.race([
      watcher.promise,
      pauseForHumanInteraction(
        `No se pudo clickear Download -> MP3 Audio para la versión ${label}. Por favor, descárgala manualmente en Suno. El sistema la detectará en cuanto caiga a Downloads.`,
        { abortSignal: ac.signal }
      ).then(() => null)
    ]);

    if (finalPath) {
      ac.abort(); // El watcher ganó: cancelar el listener de stdin
      return finalPath;
    }

    // Si el humano apretó Enter pero el watcher no resolvió, dar 500ms de gracia
    // por si el archivo estaba por terminar de guardarse.
    const checkPath = await Promise.race([
      watcher.promise,
      new Promise((resolve) => setTimeout(() => resolve(null), 500))
    ]);
    if (checkPath) return checkPath;

    throw new Error(`Agotados los intentos para descargar la versión ${label}, y el humano presionó Enter sin completar la descarga manual.`);
  } catch (e) {
    watcher.cancel();
    throw e;
  }
}

// ─── Punto de entrada público ─────────────────────────────────────────────────

// Conecta al Chrome de Suno, verifica el formulario, clickea Create (×2),
// espera generación y descarga ambos MP3 vía menú ⋯ → Download → MP3 Audio.
// Devuelve { versionA, versionB } con rutas locales. Lanza si no puede recuperar.
async function createAndDownload({ sunoDir = SUNO_DIR } = {}) {
  fs.mkdirSync(sunoDir, { recursive: true });

  const { browser, page } = await connectToSunoTab(chromium, DEBUG_PORT);

  try {
    // 1. Verificación del formulario ANTES de Create
    console.log('  Verificando formulario y créditos antes de clickear Create...');
    await checkSunoCredits(page);

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

    // 3. Click Create UNA SOLA VEZ — Suno v5.5 genera 2 versiones por click
    // (el doble click era el diseño correcto para la versión vieja de Suno;
    // hoy genera 4 canciones y quema créditos de más).
    const createBtn = page.getByRole('button', { name: CREATE_SONG_ROLE_NAME, exact: true })
      .or(page.locator(CREATE_SONG_ARIA_SELECTOR))
      .first();
    await createBtn.waitFor({ state: 'visible', timeout: 15000 });

    await ensureCreateClickable(page, createBtn, 'Create');

    console.log('  Click en Create...');
    await safeClick(page, createBtn, {
      label: 'Create',
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

    // Confirmar que el click REALMENTE arrancó una generación — nunca dar por
    // hecho que clickear (aunque Playwright no haya lanzado error) generó
    // algo. Un solo click genera 2 versiones: waitForCreateStarted espera
    // hasta CREATE_CARDS_TIMEOUT_MS a que aparezcan hasta 2 hrefs nuevos,
    // porque la 2da card puede aparecer un instante después de la 1ra. Si no
    // aparece ninguna, reintentar con JS click antes de rendirse.
    let fresh = await waitForCreateStarted(page, existingHrefs);
    if (fresh.length === 0) {
      console.log('  ⚠️ No apareció ninguna card nueva tras el click en Create. Reintentando con JS click...');
      await jsClickCreate(page).catch(() => {});
      fresh = await waitForCreateStarted(page, existingHrefs);
    }
    if (fresh.length === 0) {
      await page.screenshot({ path: 'suno-create-no-card-detected.png' }).catch(() => {});
      console.warn('  ⚠️ Fallaron todos los métodos para hacer click en Create o generar cards.');
      await pauseForHumanInteraction('No se pudo clickear Create automáticamente o Suno no generó nada. Por favor, haz click en Create manualmente en la ventana de Chrome.');
      
      // Esperar a que el humano clickee y aparezcan las cards
      console.log('  ⏳ Esperando a que aparezcan cards generadas manualmente...');
      fresh = await waitForCreateStarted(page, existingHrefs, CREATE_CARDS_TIMEOUT_MS * 3); // Damos más tiempo para interacción manual
      if (fresh.length === 0) {
         throw new Error('Incluso tras la espera manual, no se detectaron nuevas canciones.');
      }
    }
    if (fresh.length > 2) {
      console.log(`  ⚠️⚠️ Se detectaron ${fresh.length} cards nuevas tras UN SOLO click en Create — algo clickeó de más. Procesando solo las primeras 2.`);
    } else if (fresh.length === 1) {
      console.log('  ⚠️ Solo se detectó 1 card nueva tras el click en Create. Se continúa con 1 versión.');
    } else {
      console.log('  ✅ Create confirmado (2 cards nuevas detectadas).');
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
    //
    // Fase A (secuencial — es la misma pestaña, no se puede clickear 2 menús
    // a la vez): para cada versión, arrancar su watcher de filesystem y
    // clickear "MP3 Audio". Rápido (segundos), a diferencia de la ESPERA del
    // archivo en sí (minutos) — antes ambas fases estaban fusionadas por
    // versión, así que B ni siquiera empezaba a clickear hasta que A hubiera
    // terminado de DESCARGAR del todo (hasta 8 min desperdiciados sin motivo,
    // ver LESSONS.md auditoría 2026-07-03/04: Suno ya generó ambas cards en
    // simultáneo, no hay razón para esperarlas en serie).
    const cleanTitle = verify.titulo.replace(/[<>:"\/\\|?*]+/g, '').trim();
    const versionLabels = ['A', 'B'];
    const watchDirs = [sunoDir];
    if (path.resolve(DEFAULT_DOWNLOADS) !== path.resolve(sunoDir)) watchDirs.push(DEFAULT_DOWNLOADS);

    const plans = []; // { label, watcher, clicked }
    for (let i = 0; i < readyCards.length; i++) {
      const versionLabel = versionLabels[i];
      // Bug fix: guardar nombre exacto en vez de "fecha-slug-A".
      // Si hay 2 versiones, la segunda lleva la letra para no pisarse.
      const fileName = (i === 0) ? `${cleanTitle}.mp3` : `${cleanTitle} ${versionLabel}.mp3`;
      const destPath = getUniqueDestPath(path.join(sunoDir, fileName));

      console.log(`\n  Iniciando descarga Versión ${versionLabel} (⋯ → Download → MP3 Audio) — "${readyCards[i].title}"...`);
      // Watcher arranca ANTES de tocar el menú (para no perder el evento de FS).
      const watcher = watchForNewMp3(watchDirs, destPath, DOWNLOAD_WAIT_TIMEOUT_MS);
      try {
        const clicked = await clickDownloadMp3(page, readyCards[i].href, versionLabel, DOWNLOAD_WAIT_TIMEOUT_MS);
        plans.push({ label: versionLabel, watcher, clicked });
        await page.waitForTimeout(1500); // dar tiempo a que el menú se cierre antes de tocar la próxima card
      } catch (e) {
        // Fallo estructural (card/⋯ desaparecieron) — esta versión no tiene
        // watcher útil, cancelarlo ya (nunca dejarlo huérfano).
        watcher.cancel();
        console.log(`  ❌ No se pudo iniciar la descarga de la Versión ${versionLabel}: ${e.message}`);
      }
    }

    // Fase B: esperar los archivos. Las que sí se clickearon esperan EN
    // PARALELO (sin recursos compartidos entre ellas — seguro). Las que no
    // se lograron clickear caen al fallback manual, siempre SECUENCIAL
    // (pauseForHumanInteraction comparte el listener de stdin — ver su
    // comentario en awaitManualDownload).
    const clickedPlans = plans.filter((p) => p.clicked);
    const unclickedPlans = plans.filter((p) => !p.clicked);

    const downloadedPaths = [];
    const settled = await Promise.allSettled(
      clickedPlans.map((p) => awaitClickedDownload(p.watcher, p.label).then((filePath) => ({ label: p.label, path: filePath })))
    );
    for (const r of settled) {
      if (r.status === 'fulfilled') downloadedPaths.push(r.value);
      else console.log(`  ❌ ${r.reason.message}`);
    }

    for (const p of unclickedPlans) {
      try {
        const finalPath = await awaitManualDownload(p.watcher, p.label);
        downloadedPaths.push({ label: p.label, path: finalPath });
      } catch (e) {
        console.log(`  ❌ No se pudo descargar la Versión ${p.label}: ${e.message}`);
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

    // Mapear por etiqueta, no por posición: si la descarga de A falló y la de
    // B funcionó, downloadedPaths[0] sería la B — devolverla como versionA
    // haría que upload-to-flow busque un archivo "-A.mp3" que no existe.
    return {
      versionA: downloadedPaths.find((d) => d.label === 'A') || null,
      versionB: downloadedPaths.find((d) => d.label === 'B') || null,
    };

  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { createAndDownload, DOWNLOAD_WAIT_TIMEOUT_MS, GENERATION_TIMEOUT_MS };
