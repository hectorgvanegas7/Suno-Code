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
// Bug 3 fix (carpeta, versión ORIGINAL, ya reemplazada — ver más abajo):
// primero fue fs.watch sobre Downloads general + Downloads/suno/ en paralelo
// ("el que recibe el archivo primero gana"), después un `claimedPaths`
// compartido para evitar que A y B se pisaran el mismo archivo nuevo. Ambos
// enfoques vigilaban una carpeta compartida y trataban de adivinar qué
// archivo pertenecía a qué versión — la fuente de TODOS los bugs de carrera
// documentados en LESSONS.md (ENOENT, robo de archivo entre A/B, etc.).
// Mecanismo ACTUAL (documentado honesto, auditoría 2026-07-09 — LESSONS.md
// #3 del 2026-07-07 ya había detectado que los comentarios prometían más de
// lo que el código hace): el evento nativo `page.on('download')` CONFIRMA
// que la descarga arrancó y `download.failure()` espera a que termine, pero
// el archivo real se localiza con `findDownloadedFile` (título + mtime) y
// `renameSync` — NO se usa `download.saveAs()`. Funciona porque el loop de
// descargas es SECUENCIAL (A se reclama y renombra a un nombre temporal
// antes de tocar B) — contrato fijado en test/find-downloaded-file.test.js.
// Si algún día se paraleliza A/B, migrar antes a saveAs() de verdad.
//
// ⚠️ NO reintroducir descarga por interceptación de red / fetch de la URL de
// audio (visto en el repo el 2026-07-03, ya retirado): un <a download> hacia
// una URL cross-origin sin Content-Disposition: attachment del lado del
// servidor no garantiza que el navegador guarde el archivo — es exactamente
// el mismo problema ya documentado y descartado el 2026-06-30 (ver
// LESSONS.md, "Flujo de descarga de Suno no tiene botón directo"). El único
// mecanismo soportado es el menú visual de abajo, confirmado con la API
// nativa de descargas de Playwright.
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
const state = require('./pipeline-state');
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
// Tiempo máximo para esperar que Chrome confirme el INICIO de una descarga
// (evento nativo `page.on('download')`) después de clickear "MP3 Audio".
// Medido en vivo con un diagnóstico aislado (Antigravity, 2026-07-04, ver
// LESSONS.md): Suno tarda entre 2.6s y 6.3s en preparar el archivo antes de
// que el evento dispare — nunca instantáneo. 20s deja margen de sobra sobre
// ese máximo observado sin acercarse a los 8 min de DOWNLOAD_WAIT_TIMEOUT_MS
// (que sigue siendo el techo para que la descarga TERMINE de guardarse con
// saveAs() — esto solo confirma que arrancó).
const DOWNLOAD_START_CONFIRM_TIMEOUT_MS = 20000;

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

// Localiza el archivo que Chrome realmente descargó en sunoDir buscando
// el más reciente modificado después de startTime que coincida con el título.
// Esto permite que conviva con preexistentes y que Chrome use el sufijo nativo " (1)".
function findDownloadedFile(sunoDir, cleanTitle, startTime) {
  const files = fs.readdirSync(sunoDir);
  const escapedTitle = cleanTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escapedTitle}(\\s\\(\\d+\\))?\\.mp3$`, 'i');

  let bestFile = null;
  let bestMtime = 0;

  for (const f of files) {
    if (regex.test(f)) {
      const fullPath = path.join(sunoDir, f);
      const stat = fs.statSync(fullPath);
      // Solo tomamos en cuenta archivos modificados después del inicio de la descarga (con tolerancia de 60s por clock drift)
      if (stat.mtimeMs >= (startTime - 60000) && stat.mtimeMs > bestMtime) {
        bestMtime = stat.mtimeMs;
        bestFile = fullPath;
      }
    }
  }
  return bestFile;
}


// Configura el directorio de descarga vía CDP — best-effort. Habilita
// `behavior: 'allow'` + `eventsEnabled: true`, que es lo que permite que
// `page.on('download')`/`waitForEvent('download')` disparen de forma
// confiable sobre una conexión connectOverCDP (confirmado en vivo por el
// diagnóstico de Antigravity, 2026-07-04). `download.saveAs()` no depende de
// `downloadPath` para encontrar el archivo — lo maneja Playwright
// internamente — pero dejar el directorio configurado no hace daño.
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
    console.log(`  [download] Se sigue igual — el archivo se localiza después con findDownloadedFile.`);
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
  let emptyPolls = 0;

  while (Date.now() - startTime < timeoutMs) {
    const rows = await scanClipRows(page);
    const candidates = rows.filter((r) => newHrefSet.has(r.href));

    // Si las cards que acabamos de crear desaparecen del DOM por más de 2
    // minutos seguidos, Suno probablemente falló la generación (y reembolsó
    // los créditos) — mejor frenar con un error claro que seguir esperando
    // a ciegas hasta el timeout completo.
    if (candidates.length === 0) {
      emptyPolls++;
      if (emptyPolls >= 40) { // 40 * 3s de poll ≈ 120s
        throw new Error(
          `Las cards de "${normTitle}" desaparecieron de la UI de Suno por más de 2 minutos. ` +
          'Suno podría haber fallado la generación y reembolsado los créditos.'
        );
      }
    } else {
      emptyPolls = 0;
    }

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

  // Desactivar pointer-events en SVGs de la card (waveform/progress) para que
  // no intercepten el click en ⋯. Sin esto, safeClick escala a force:true y
  // Radix UI no cablea bien el submenú — "MP3 Audio" nunca aparece.
  // Bug real 2026-07-13: SVG <path> bloqueaba el ⋯ en TODAS las iteraciones.
  await page.evaluate((cardHref) => {
    const link = document.querySelector(`a[href="${cardHref}"]`);
    if (!link) return;
    let container = link.closest('[class*="row"], [class*="clip"], [class*="card"]');
    if (!container) container = link.parentElement?.parentElement?.parentElement;
    if (container) {
      container.querySelectorAll('svg, svg *').forEach(el => {
        el.style.pointerEvents = 'none';
      });
    }
  }, href);

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
    await downloadItem.hover({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(500);
    if (await mp3Item.count() > 0 && await mp3Item.first().isVisible().catch(() => false)) {
      break;
    }
    // Optimización de ejecución AGY: Fallback de teclado para Radix UI (muy robusto si falla el puntero)
    await downloadItem.focus({ timeout: 2000 }).catch(() => {});
    await page.keyboard.press('ArrowRight').catch(() => {});
    await page.waitForTimeout(500);
    if (await mp3Item.count() > 0 && await mp3Item.first().isVisible().catch(() => false)) {
      break;
    }
    // Fallback: algunos builds abren el submenú con click en el subtrigger
    if (h === HOVER_ATTEMPTS) {
      await downloadItem.click({ timeout: 2000 }).catch(() => {});
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
    await downloadItem.hover({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(500);
  }

  if (!mp3Visible) {
    await page.screenshot({ path: `suno-dl-submenu-${label}.png` }).catch(() => {});

    // Nuclear fallback: si el flyout de Radix no renderizó "MP3 Audio" visualmente
    // (ej. menú abierto con force:true, DOM stale, z-index roto), buscarlo en el
    // DOM completo y clickearlo con JS. El evento de descarga sigue siendo capturado
    // por el listener CDP del caller. Bug real 2026-07-13.
    const jsClicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const mp3Btn = btns.find(b => {
        const al = b.getAttribute('aria-label') || '';
        const txt = (b.textContent || '').trim();
        const isMP3 = al === 'MP3 Audio' || txt === 'MP3 Audio';
        const isWAV = /wav|lossless/i.test(txt) && !/mp3/i.test(txt);
        return isMP3 && !isWAV;
      });
      if (mp3Btn) { mp3Btn.click(); return true; }
      return false;
    });
    if (jsClicked) {
      console.log(`  [dl] ✅ MP3 Audio clickeado vía JS directo (submenu no renderizó visualmente).`);
      return 'clicked';
    }

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
// Devuelve el objeto `Download` nativo de Playwright si Chrome CONFIRMÓ que
// la descarga arrancó (evento `page.on('download')`), o `null` si agotó el
// tiempo sin lograr clickear o sin que Chrome confirmara (fallo "blando" — el
// caller decide si cae al fallback manual). Solo LANZA ante un fallo
// estructural (la card o el ⋯ desaparecieron del DOM 3 veces seguidas) — no
// tiene sentido seguir esperando ahí.
// Fallback de la descarga cuando el evento nativo `page.on('download')` no
// confirma nada: puede pasar si la conexión CDP se abrió con
// `{ noDefaults: true }` (necesario para evitar el "Protocol error" de
// connectOverCDP — ver lib/playwright-helpers.js), que en algunos casos deja
// de interceptar descargas. Pollea `sunoDir` buscando el archivo nuevo (por
// título + hora de inicio, MISMO criterio ya testeado que usa
// findDownloadedFile más abajo) y lo da por completo cuando su tamaño deja
// de crecer entre dos chequeos. Nunca decide QUÉ archivo es — solo detecta
// "algo terminó de descargarse"; la atribución real sigue pasando por
// findDownloadedFile en createAndDownload.
async function pollForNewFile(sunoDir, cleanTitle, downloadStartTime, timeoutMs) {
  if (!sunoDir || !cleanTitle || !downloadStartTime) return null;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const file = findDownloadedFile(sunoDir, cleanTitle, downloadStartTime);
      if (file && fs.existsSync(file)) {
        const size1 = fs.statSync(file).size;
        await new Promise((r) => setTimeout(r, 600));
        const size2 = fs.statSync(file).size;
        if (size1 === size2 && size1 > 0) {
          // Objeto mínimo compatible con el único método que el caller usa
          // sobre el resultado de clickDownloadMp3/awaitManualDownload
          // (`download.failure()`) — la ubicación real del archivo se
          // re-deriva siempre con findDownloadedFile, nunca desde acá.
          return { failure: async () => null };
        }
      }
    } catch {
      // Errores temporales de lectura (archivo a medio escribir) — ignorar y reintentar.
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return null;
}

async function clickDownloadMp3(page, href, label, deadlineMs, { sunoDir = null, cleanTitle = null, downloadStartTime = null } = {}) {
  const start = Date.now();
  let attempt = 0;

  // Flujo visual: ⋯ → Download → MP3 Audio (el único mecanismo — ver nota
  // en el header del archivo sobre por qué no hay bypass de red).
  while (Date.now() - start < deadlineMs) {
    attempt++;

    // El listener del evento nativo se (re)arma en CADA intento, justo antes
    // del click. La versión anterior lo creaba UNA sola vez antes del bucle:
    // su timeout de 20s corría desde la creación, así que si "MP3 Audio"
    // tardaba >20s en estar listo (reintentos por "not-ready"), la promesa ya
    // había expirado en null cuando el click por fin ocurría — la descarga
    // real quedaba "sin confirmar" siempre y se desviaba al camino manual sin
    // necesidad (auditoría 2026-07-09). El objeto Download que resuelve acá
    // es una referencia inequívoca a ESTA descarga concreta. Corre en carrera
    // contra pollForNewFile — ver comentario arriba de esa función.
    const downloadEventPromise = Promise.race([
      page.waitForEvent('download', { timeout: DOWNLOAD_START_CONFIRM_TIMEOUT_MS }).catch(() => null),
      pollForNewFile(sunoDir, cleanTitle, downloadStartTime, DOWNLOAD_START_CONFIRM_TIMEOUT_MS),
    ]);

    const result = await tryOpenDownloadMp3(page, href, label);

    if (result === 'clicked') {
      console.log(`  [dl] Click en "MP3 Audio" (versión ${label}, intento ${attempt}). Esperando que Chrome confirme el inicio de la descarga...`);
      // Bug real (2026-07-04, ver LESSONS.md): Suno tarda 2.6-6.3s en
      // preparar el archivo después del click — tocar la UI de la SIGUIENTE
      // card (abrir su menú, Escape, etc.) antes de eso cancela en silencio
      // la descarga en curso de ESTA. Por eso acá adentro se espera la
      // confirmación real de Chrome antes de devolver el control al caller,
      // que recién ahí pasa a la próxima card.
      const download = await downloadEventPromise;
      if (download) {
        console.log(`  ✅ Descarga confirmada por Chrome para la versión ${label}.`);
      } else {
        console.log(`  ⚠️ Chrome no confirmó el inicio de la descarga de la versión ${label} en ${DOWNLOAD_START_CONFIRM_TIMEOUT_MS / 1000}s tras el click — puede haberse cancelado o tardar más de lo normal.`);
      }
      return download;
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
  return null;
}

// Fase 2 de la descarga (versión que SÍ arrancó) — cómo se resuelve el
// archivo EN REALIDAD (comentario corregido, auditoría 2026-07-09; la
// versión anterior prometía saveAs() + descargas en paralelo que el código
// nunca tuvo): se espera `download.failure()` (null = terminó bien) con un
// techo de 8 min, y el archivo se localiza con findDownloadedFile
// (título+mtime) y se renombra de inmediato a un nombre temporal/definitivo.
// El loop es SECUENCIAL entre A y B a propósito — el rename inmediato de A
// es lo que evita que la búsqueda por título de B agarre el archivo
// equivocado. Contrato fijado en test/find-downloaded-file.test.js.


// Fase 2 de la descarga (versión que NO se logró clickear automáticamente):
// fallback manual. Un click humano en "MP3 Audio" dispara el MISMO evento
// nativo `page.on('download')` que un click automatizado, así que no hace
// falta ningún mecanismo aparte para detectarlo. Deliberadamente SECUENCIAL
// en el caller (nunca en paralelo con otra llamada a este mismo helper) —
// pauseForHumanInteraction escucha 'data' en process.stdin sin distinguir de
// qué llamada es, así que dos esperas manuales corriendo a la vez harían que
// un solo ENTER resuelva ambas de golpe, aunque el humano solo haya
// terminado una descarga.
async function awaitManualDownload(page, label, deadlineMs, { sunoDir = null, cleanTitle = null, downloadStartTime = null } = {}) {
  console.warn(`  ⚠️ Falló la descarga automática para la versión ${label}.`);
  const playwrightDownloadPromise = page.waitForEvent('download', { timeout: deadlineMs }).catch(() => null);
  const pollDownloadPromise = pollForNewFile(sunoDir, cleanTitle, downloadStartTime, deadlineMs);
  const ac = new AbortController();
  const download = await Promise.race([
    playwrightDownloadPromise,
    pollDownloadPromise,
    pauseForHumanInteraction(
      `No se pudo clickear Download -> MP3 Audio para la versión ${label}. Por favor, descárgala manualmente en Suno. El sistema la detectará solo.`,
      { abortSignal: ac.signal }
    ).then(() => null),
  ]);

  if (download) {
    ac.abort(); // La descarga nativa o el polling ganó: cancelar el listener de stdin
    return download;
  }

  // El humano presionó ENTER (o las promesas de descarga ya agotaron su
  // propio tiempo) — dar un margen corto por si la descarga estaba
  // terminando de dispararse.
  const graceDownload = await Promise.race([
    playwrightDownloadPromise,
    pollForNewFile(sunoDir, cleanTitle, downloadStartTime, 3000),
  ]);
  if (graceDownload) return graceDownload;

  throw new Error(`Agotados los intentos para descargar la versión ${label}, y no se detectó ninguna descarga real.`);
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

    // CDP redirect (best-effort) + eventsEnabled para que page.on('download')
    // dispare confiable sobre connectOverCDP. (fs.watch ya no existe — el
    // archivo se localiza después con findDownloadedFile, ver header.)
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

    // ── Write-ahead intent (auditoría de idempotencia 2026-07-14) ──────────
    // Registrar en state.json ANTES del click físico que estamos por gastar
    // créditos. Si el proceso muere entre el click y la descarga (kill del
    // watchdog, crash, corte de luz), el intent queda en disco con clickedAt
    // pero sin downloadedAt — y tanto el retry-loop de start-flow.js como un
    // --resume posterior saben que NUNCA deben re-clickear Create (usan
    // downloadOnly / búsqueda en disco). Conservador a propósito: si el click
    // en realidad no prendió, lo peor que pasa es que un humano tenga que
    // confirmar — nunca se gastan créditos dos veces en silencio.
    state.recordIntent('create', {
      songId: state.read()?.songId || null,
      requestedAt: new Date().toISOString(),
      clickedAt: new Date().toISOString(),
    });

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
      // Dismiss fresco antes del click de fallback — la regla de LESSONS.md es
      // "antes de CADA click en Create": un popout pudo abrirse mientras
      // safeClick agotaba sus intentos.
      await ensureCreateClickable(page, createBtn, 'Create').catch(() => {});
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
      await ensureCreateClickable(page, createBtn, 'Create').catch(() => {});
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

    return await downloadReadyCards(page, readyCards, verify.titulo, sunoDir);

  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── Descarga de cards ya generadas (compartida) ─────────────────────────────
// Descarga a sunoDir las cards YA listas que le pasan — la usan tanto
// createAndDownload (camino normal) como downloadOnly (recuperación post-click
// sin re-Create). JAMÁS clickea Create. Al confirmar al menos una descarga,
// registra downloadedAt en el intent de create (cierra el write-ahead).
async function downloadReadyCards(page, readyCards, titulo, sunoDir) {
    // Cerrar el mini-player nuevamente antes de descargar — puede tapar el
    // botón ⋯ con z-index.
    await dismissMiniPlayerIfPresent(page);
    await page.waitForTimeout(500);

    await page.screenshot({ path: 'suno-before-download.png' });

    const cleanTitle = titulo.replace(/[<>:"\/\\|?*]+/g, '').trim();
    const versionLabels = ['A', 'B'];

    const plans = []; // { label, destPath, download, tempDestPath }
    for (let i = 0; i < readyCards.length; i++) {
      const versionLabel = versionLabels[i];
      // Para evitar que Chrome renombre la versión B a "Cancion (1).mp3" por colisión
      // de nombre sugerido en sunoDir, descargaremos la versión A e inmediatamente
      // la renombraremos a un nombre temporal (cancion_temp_a.mp3) antes de iniciar
      // la descarga de B. Al final del proceso, renombramos el temporal a su nombre definitivo.
      const fileName = (i === 0) ? `${cleanTitle}.mp3` : `${cleanTitle} ${versionLabel}.mp3`;
      const destPath = getUniqueDestPath(path.join(sunoDir, fileName));
      const tempDestPath = (i === 0) ? path.join(sunoDir, `${cleanTitle}_temp_a.mp3`) : destPath;

      // Hora de inicio de la descarga para identificar el archivo correcto en sunoDir.
      // Restamos 5 segundos como margen de tolerancia para skews de reloj del sistema de archivos.
      const downloadStartTime = Date.now() - 5000;

      console.log(`\n  Iniciando descarga Versión ${versionLabel} (⋯ → Download → MP3 Audio) — "${readyCards[i].title}"...`);
      let download = null;
      try {
        download = await clickDownloadMp3(page, readyCards[i].href, versionLabel, DOWNLOAD_WAIT_TIMEOUT_MS, { sunoDir, cleanTitle, downloadStartTime });
      } catch (e) {
        console.log(`  ❌ No se pudo iniciar la descarga de la Versión ${versionLabel}: ${e.message}`);
      }
      if (!download) {
        try {
          download = await awaitManualDownload(page, versionLabel, DOWNLOAD_WAIT_TIMEOUT_MS, { sunoDir, cleanTitle, downloadStartTime });
        } catch (e) {
          console.log(`  ❌ ${e.message}`);
        }
      }

      if (download) {
        try {
          console.log(`  ⏳ Esperando que Chrome complete la descarga de la Versión ${versionLabel}...`);
          const failure = await Promise.race([
            download.failure(),
            new Promise((_, reject) => setTimeout(
              () => reject(new Error(`Timeout ${DOWNLOAD_WAIT_TIMEOUT_MS}ms esperando la descarga en Chrome.`)),
              DOWNLOAD_WAIT_TIMEOUT_MS
            )),
          ]);
          if (failure) {
            throw new Error(`Chrome reportó fallo en la descarga: ${failure}`);
          }

          // Pequeño delay para liberar lock de escritura del sistema
          await new Promise(r => setTimeout(r, 200));

          // Encontrar el archivo que Chrome realmente escribió en el directorio de descargas de Suno,
          // soportando sufijos automáticos de colisión nativos de Chrome (" (1)", " (2)", etc.)
          // en lugar de borrar archivos preexistentes ciegamente.
          const currentDownloadedFile = findDownloadedFile(sunoDir, cleanTitle, downloadStartTime);
          if (!currentDownloadedFile) {
            throw new Error(`El archivo descargado no se pudo localizar en ${sunoDir} bajo el patrón de "${cleanTitle}".`);
          }

          // Renombrar inmediatamente al path temporal o definitivo
          fs.renameSync(currentDownloadedFile, tempDestPath);
          
          // FIX (2026-07-14): Inyectar Xing header con ffmpeg para evitar que los reproductores 
          // calculen mal la duración por ser VBR (el "bug de los 7 minutos").
          try {
            const { execFileSync } = require('child_process');
            const ffmpegTemp = tempDestPath + '.fixed.mp3';
            execFileSync('ffmpeg', ['-y', '-i', tempDestPath, '-c', 'copy', ffmpegTemp], { stdio: 'ignore' });
            fs.renameSync(ffmpegTemp, tempDestPath);
            console.log(`  🔧 Cabecera VBR arreglada con ffmpeg (duración real corregida).`);
          } catch (ffmpegErr) {
            console.log(`  ⚠️ No se pudo arreglar la cabecera VBR con ffmpeg, la duración podría mostrarse mal: ${ffmpegErr.message}`);
          }

          console.log(`  ✅ Versión ${versionLabel} descargada y guardada temporalmente en: ${path.basename(tempDestPath)}`);
          plans.push({ label: versionLabel, destPath, tempDestPath, success: true });
        } catch (err) {
          console.log(`  ❌ Error procesando el archivo de la Versión ${versionLabel}: ${err.message}`);
          plans.push({ label: versionLabel, destPath, tempDestPath, success: false });
        }
      } else {
        plans.push({ label: versionLabel, destPath, tempDestPath, success: false });
      }

      await page.waitForTimeout(500); // pequeño margen para que el menú se cierre antes de tocar la próxima card
    }

    // Si la versión A se descargó con éxito, restaurar su nombre definitivo (de cancion_temp_a.mp3 a cancion.mp3)
    const planA = plans.find(p => p.label === 'A');
    if (planA && planA.success && fs.existsSync(planA.tempDestPath)) {
      try {
        fs.renameSync(planA.tempDestPath, planA.destPath);
        console.log(`  ✅ Versión A renombrada a su nombre definitivo: ${path.basename(planA.destPath)}`);
      } catch (err) {
        console.log(`  ❌ Error al renombrar la versión A a su nombre definitivo: ${err.message}`);
        planA.success = false; // marcar como fallo si no pudimos dejar el nombre definitivo
      }
    }

    const downloadedPaths = plans
      .filter((p) => p.success)
      .map((p) => ({ label: p.label, path: p.destPath }));

    for (const p of plans.filter((p) => !p.success)) {
      console.log(`  ❌ No se pudo descargar la Versión ${p.label}.`);
      console.log(`     Descargala manualmente: botón ⋯ de la canción "${titulo}" → Download → MP3 Audio`);
      console.log(`     Guardala en: ${sunoDir}`);
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

    // Registro exacto de qué archivo es cada versión (auditoría 2026-07-14):
    // path + sha256 + bytes en state.json, para que upload-to-flow.js suba el
    // archivo EXACTO en vez de adivinar por título+recencia (que puede agarrar
    // un MP3 viejo o de otra canción con título parecido). El sha256 permite
    // detectar si el archivo cambió/se corrompió entre la descarga y la subida.
    const downloads = {};
    for (const { label, path: p } of downloadedPaths) {
      try {
        const buf = fs.readFileSync(p);
        downloads[label] = {
          path: p,
          sha256: require('crypto').createHash('sha256').update(buf).digest('hex').slice(0, 16),
          bytes: buf.length,
        };
      } catch (e) {
        console.log(`  ⚠️ No se pudo hashear la Versión ${label} (${e.message}) — se registra solo el path.`);
        downloads[label] = { path: p, sha256: null, bytes: null };
      }
    }
    state.write({ downloads });
    // Cierra el write-ahead del Create: hay al menos un MP3 confirmado en disco.
    state.recordIntent('create', { downloadedAt: new Date().toISOString() });

    // Mapear por etiqueta, no por posición: si la descarga de A falló y la de
    // B funcionó, downloadedPaths[0] sería la B — devolverla como versionA
    // haría que upload-to-flow busque un archivo "-A.mp3" que no existe.
    return {
      versionA: downloadedPaths.find((d) => d.label === 'A') || null,
      versionB: downloadedPaths.find((d) => d.label === 'B') || null,
    };
}

// ─── Recuperación post-click: descargar SIN tocar Create ─────────────────────
// Para cuando el intent de create dice clickedAt sin downloadedAt (créditos ya
// gastados, descarga nunca confirmada): busca en la UI de Suno las cards MÁS
// RECIENTES cuyo título coincida con la canción actual, espera a que terminen
// de generarse si hace falta, y las descarga con el mismo mecanismo de siempre.
// JAMÁS clickea Create — ese es el punto entero de esta función.
async function downloadOnly({ sunoDir = SUNO_DIR, titulo } = {}) {
  if (!titulo) {
    throw new Error('downloadOnly necesita el título de la canción (state.json → titulo).');
  }
  fs.mkdirSync(sunoDir, { recursive: true });

  const { browser, page } = await connectToSunoTab(chromium, DEBUG_PORT);
  try {
    await configureDownloadDir(browser, sunoDir);
    await dismissMiniPlayerIfPresent(page);
    await page.waitForTimeout(300);

    const normTitle = normalize(titulo);
    const rows = await scanClipRows(page);
    // Suno inserta las cards nuevas ARRIBA de la lista (orden estable): las
    // primeras (hasta 2) que coincidan con el título son las de la generación
    // que estamos recuperando — nunca cards más viejas del mismo título.
    const candidates = rows.filter((r) => r.normTitle === normTitle).slice(0, 2);
    if (candidates.length === 0) {
      throw new Error(
        `downloadOnly: no se encontró ninguna card de "${titulo}" en la UI de Suno. ` +
        '¿El click en Create realmente prendió? Revisá suno.com/create a mano.'
      );
    }
    console.log(`  🔁 downloadOnly: ${candidates.length} card(s) de "${titulo}" encontradas — descargando SIN re-clickear Create.`);

    const hrefSet = new Set(candidates.map((r) => r.href));
    const readyCards = await waitForGeneration(page, hrefSet, normTitle, hrefSet.size, GENERATION_TIMEOUT_MS);
    if (readyCards.length === 0) {
      throw new Error(
        `downloadOnly: las cards de "${titulo}" nunca quedaron listas (${GENERATION_TIMEOUT_MS / 60000} min). ` +
        'Verificá el estado de Suno en el navegador.'
      );
    }

    return await downloadReadyCards(page, readyCards, titulo, sunoDir);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── Decisión PURA de reintento de Create (test/suno-create-dl-config.test.js) ─
// Regla inquebrantable de Hector: NUNCA re-clickear Create automáticamente si
// ya se clickeó una vez (gasta créditos reales). Esta función es la única
// autoridad sobre qué hace el retry-loop de start-flow.js:
//   'retry-create'        → el fallo fue ANTES del click (clickedAt ausente):
//                           reintentar Create es seguro, no se gastó nada.
//   'retry-download-only' → clickedAt presente: los créditos ya se gastaron;
//                           solo se reintenta la DESCARGA (downloadOnly).
//   'give-up'             → intentos agotados: pausa humana / aviso, nunca
//                           ninguna acción automática que gaste créditos.
function decideCreateRetry({ clickedAt, attempt, maxAttempts = 3 }) {
  if (attempt >= maxAttempts) return 'give-up';
  return clickedAt ? 'retry-download-only' : 'retry-create';
}

module.exports = { createAndDownload, downloadOnly, downloadReadyCards, decideCreateRetry, ensureCreateClickable, findDownloadedFile, DOWNLOAD_WAIT_TIMEOUT_MS, GENERATION_TIMEOUT_MS };
