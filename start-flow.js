// start-flow.js — Orquestador único del pipeline. Un solo comando:
//
//   node start-flow.js                  -> flujo completo: genera letra, llena
//                                          Suno, clickea Create automáticamente,
//                                          espera generación, descarga ambos MP3,
//                                          llena el Flow, sube automáticamente
//                                          la versión que recomienda el análisis
//                                          de audio (B por defecto si no hay
//                                          reporte confiable) y queda esperando a
//                                          detectar el Submit to QA manual para
//                                          cerrar (Sheets + Drive) solo.
//
//   node start-flow.js --no-auto-create -> igual pero SIN clickear Create ni
//                                          descargar (vuelve al flujo manual
//                                          anterior, útil si algo falla).
//
//   node start-flow.js --no-auto-verify -> igual pero SIN lanzar verify-audio.js
//                                          automático en background tras los MP3
//                                          (Gabo lo corre a mano cuando quiera).
//
//   node start-flow.js --fast-verify    -> el auto-verify (si no se saltea)
//                                          fuerza el modo rápido (Whisper
//                                          small/CPU) en vez de --demucs, que
//                                          es el default.
//
//   node start-flow.js --resume         -> retoma un pipeline cortado a mitad de
//                                          camino usando state.json: salta los
//                                          pasos ya completados (letra, Suno,
//                                          Flow). NUNCA re-clickea Create — si
//                                          los MP3 no están en disco, Create y
//                                          descarga quedan manuales.
//
//   node start-flow.js --done           -> cierre: registra la canción en la
//                                          hoja y marca el estado como completado.
//                                          Se corre DESPUÉS de hacer Submit to QA.
//
//   node start-flow.js --poll [N]       -> vigía de cola: verifica si cayó una
//                                          canción. Default: intervalo aleatorio
//                                          10-15s. Acepta minutos ("3"), segundos
//                                          ("30s") o rangos ("10-15s", "1-2").
//
//   node start-flow.js --dry-run        -> ensayo COMPLETO sin gastar nada:
//                                          run.js con mock local (cero API),
//                                          cero Chrome/Suno/Flow (todo simulado),
//                                          pero ejercita de verdad los checkpoints
//                                          de ENTER y las notificaciones ntfy.
//                                          Respalda y restaura song.txt para no
//                                          pisar una canción real en curso.
//
//   node start-flow.js --pause          -> activa checkpoints de verificación
//                                          humana (ENTER antes del Create de Suno
//                                          y antes de subir el MP3 al Flow), con
//                                          beep + ntfy. Por DEFAULT están
//                                          desactivados: la única interacción
//                                          manual del flujo normal es el Submit
//                                          to QA (Regla Dura #1 — eso es manual
//                                          SIEMPRE, con o sin este flag).
//
// Cada corrida escribe TODA su salida (la propia + la de cada script hijo:
// run.js, suno-fill.js, flow-submit.js, upload-to-flow.js) en un único archivo
// logs/run-<timestamp>.log, además de seguir mostrándola en la terminal como
// siempre — ya no hace falta buscar entre varias ventanas si algo falla a
// mitad de camino. El auto-verify en background (Paso 3c) sigue teniendo su
// propio log aparte (logs/verify-audio-auto-<timestamp>.log) porque corre
// desacoplado del proceso padre.
//
// ══════════════════════════════════════════════════════════════════════════════
// ✅ SUBMIT TO QA AUTOMÁTICO (Anti-Bot) — Regla Dura #1 deprecada.
//    Ver CLAUDE.md. Timer aleatorio 26-31 min; click manual sigue disponible
//    antes de que dispare.
// ══════════════════════════════════════════════════════════════════════════════
//
// Pasos del modo normal:
//   0. Preflight (API key, credenciales, deps).
//   1. run.js          — genera letra, guarda song.txt, escribe state.json.
//   2. Asegura Chrome en el puerto de debug + sesión de Suno logueada.
//   3. suno-fill.js    — llena el formulario de Suno + screenshots de verify.
//   3b. (auto, desactivable) Create + esperar generación + descargar MP3s a Downloads/suno/.
//   3c. (auto, desactivable) verify-audio.js en background (--demucs por default,
//       no bloquea el Paso 4/4; log en logs/verify-audio-auto-*.log).
//   4. flow-submit.js  — llena título/letra/notas en el Flow.
//   5. Muestra la recomendación de verify-report.json y sube automáticamente
//      LA VERSIÓN RECOMENDADA por el análisis (solo si el reporte es de esta
//      canción y el análisis terminó bien; si no, B por defecto — A si solo
//      hay una). Para cambiarla: node upload-to-flow.js --version A|B
//      (manual, pisa la subida en el Flow).
//   → Auto-Submit dispara solo entre el min 26 y 31 (timer aleatorio anti-bot);
//     Gabo puede hacer click manual antes si quiere.
//   → El script detecta la card en "Recent completions" (pestaña dedicada en
//     background, título verificado contra state.json) y corre el cierre solo:
//     tiempo de sesión + screenshot + registro en Sheets + Drive.
//     Fallback si se cortó antes: node start-flow.js --done.
//
// run.js usa el MISMO Chrome del puerto 9333 (lo lanza detached si no está) y
// lo deja abierto al terminar — todos los pasos comparten esa instancia. Los
// scripts solo se desconectan del socket CDP (browser.close() sobre
// connectOverCDP desconecta, no mata Chrome — verificado en Playwright 1.61).
//
// El modo --poll reusa el MISMO puerto 9333 (unificado — antes usaba 9334 con
// un Chrome propio que abría/cerraba en cada corrida). Ya no abre ni mata una
// ventana aparte: se conecta a la instancia existente vía withCdp(), igual que
// el resto del flujo. bringToFront() solo se llama al abrir la pestaña por
// primera vez o al encontrar canción nueva, para no robar foco en cada poll.

require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { isLoggedIn, clickByText, isPortUp, confirmToContinue } = require('./lib/playwright-helpers');
const { enterFlowAndEnsureAssignment, FLOW_URL } = require('./lib/flow-helpers');
const { runPreflight } = require('./lib/preflight');
const { notify } = require('./lib/ntfy');
const state = require('./lib/pipeline-state');
const { LYRICS_TEXTAREA } = require('./lib/suno-selectors');
const { rotateOldRunFiles } = require('./lib/hygiene');
const { parseSessionTime, parseWebpageTimer } = require('./lib/session-time');
const { normalize } = require('./lib/audio-match');
const { postImageToGallery, flushPendingGalleryUploads } = require('./lib/gallery-upload');

const DEBUG_PORT = 9333;   // Chrome de Suno (ya corriendo para suno-fill y flow-submit)

// Checkpoints de verificación humana (ENTER antes de actuar). DESACTIVADOS
// por default: el flujo corre de un tirón — el Submit to QA ahora es
// automático (timer anti-bot 26-31 min). Se activan solo con --pause explícito.
// (--no-pause se acepta por compatibilidad, pero ya es el comportamiento default.)
const PAUSE_MODE = process.argv.includes('--pause') && !process.argv.includes('--no-pause');
async function checkpoint(summary, nextAction) {
  if (!PAUSE_MODE) {
    console.log(`\n▶️  ${nextAction} (sin pausa — corré con --pause si querés confirmar con ENTER acá)\n`);
    return;
  }
  await confirmToContinue(summary, { nextAction });
}
const POLL_PORT  = 9333;   // Mismo puerto, reusamos el navegador abierto
const FLOW_CREATE_URL = 'https://cancioneterna.com/artists/flow/create';
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const os = require('os');
const CHROME_PATH = process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const USER_DATA_DIR = path.join(os.homedir(), process.platform === 'win32' ? 'AppData\\Local\\ChromeAutomationProfile' : 'Library/Application Support/ChromeAutomationProfile');
const PROFILE_DIRECTORY = 'Profile 1';
const LOGIN_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const AUTO_VERIFY_LOG_DIR = path.join(__dirname, 'logs');

// ─── Log unificado por corrida ────────────────────────────────────────────────
// Todo lo que start-flow.js imprime (console.log/error) MÁS el stdout/stderr de
// cada proceso hijo lanzado por runScript() (run.js, suno-fill.js,
// flow-submit.js, upload-to-flow.js) se copia a un único archivo por corrida,
// además de seguir mostrándose en la terminal como siempre. Antes había que
// buscar la salida entre varias terminales/logs sueltos si algo fallaba a mitad
// de camino; ahora queda todo en un solo lugar con timestamp de la corrida.
//
// Usa fs.writeSync sobre un fd abierto (no un stream) para que cada línea quede
// en disco de inmediato — el pipeline llama process.exit() en varios puntos
// (runDone, runPoll, catch del entry point) y un write stream asíncrono podría
// perder las últimas líneas si el proceso muere antes de que termine de volcar
// el buffer. No cubre el log separado de verify-audio.js en background (ver
// AUTO_VERIFY_LOG_DIR arriba) — ese ya tiene su propio archivo por diseño,
// documentado en LESSONS.md, porque corre desacoplado del proceso padre.
fs.mkdirSync(AUTO_VERIFY_LOG_DIR, { recursive: true });
const RUN_LOG_PATH = path.join(AUTO_VERIFY_LOG_DIR, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
const runLogFd = fs.openSync(RUN_LOG_PATH, 'a');

function writeToRunLog(chunk) {
  try {
    fs.writeSync(runLogFd, chunk);
  } catch {
    // Un fallo de disco al loguear nunca debe romper el pipeline.
  }
}

process.on('exit', () => {
  try { fs.closeSync(runLogFd); } catch {}
});

// Registro append-only de cada intento de Auto-Submit (hora, minuto exacto
// del timer, título, resultado). Si algún cliente reclama un submit
// prematuro o el click falló en silencio, esto da el dato exacto sin tener
// que rastrear entre varios logs/run-*.log. Nunca lanza — un fallo de disco
// acá no debe frenar el pipeline.
const AUTO_SUBMIT_LOG_PATH = path.join(AUTO_VERIFY_LOG_DIR, 'auto-submit-events.jsonl');
function logAutoSubmitEvent(event) {
  try {
    fs.appendFileSync(AUTO_SUBMIT_LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n', 'utf-8');
  } catch {
    // best-effort
  }
}

// Envuelve console.log/error para que todo lo que start-flow.js imprime (y todo
// lo que imprimen los módulos que requiere, como lib/preflight.js) también
// quede en el log unificado. No reemplaza el comportamiento visible en
// terminal, solo le agrega una copia a disco.
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);
console.log = (...args) => {
  originalConsoleLog(...args);
  writeToRunLog(`${args.map(String).join(' ')}\n`);
};
console.error = (...args) => {
  originalConsoleError(...args);
  writeToRunLog(`${args.map(String).join(' ')}\n`);
};

// Corre verify-audio.js como proceso hijo ESPERADO — start-flow.js espera a que
// termine para poder leer el verify-report.json y recomendar la mejor versión.
// Si falla, NUNCA rompe el pipeline principal — solo se loguea.
function runVerifyAudio({ fast = false } = {}) {
  return new Promise((resolve) => {
    try {
      fs.mkdirSync(AUTO_VERIFY_LOG_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logPath = path.join(AUTO_VERIFY_LOG_DIR, `verify-audio-auto-${stamp}.log`);
      const logFd = fs.openSync(logPath, 'a');

      const modeLabel = fast ? 'modo rápido (Whisper small/CPU)' : '--demucs (htdemucs_ft + Whisper large-v3 CUDA)';
      console.log(`\n=== Paso 3c/4: verify-audio.js — ${modeLabel} ===`);
      console.log(`  Log: ${logPath}`);
      console.log('  (Pasá --no-auto-verify para saltear este paso, --fast-verify para forzar el modo rápido)');

      const args = fast ? ['verify-audio.js'] : ['verify-audio.js', '--demucs'];
      const child = spawn('node', args, {
        cwd: __dirname,
        stdio: ['ignore', logFd, logFd],
      });

      // El fd del log se abre por corrida — cerrarlo cuando el hijo termina,
      // si no queda un file descriptor filtrado por cada verify (en --loop se
      // acumulan durante toda la sesión).
      const closeLogFd = () => { try { fs.closeSync(logFd); } catch {} };

      child.on('error', (e) => {
        closeLogFd();
        console.log(`  ⚠️ No se pudo lanzar verify-audio.js: ${e.message}`);
        notify(`⚠️ Auto-verify no arrancó: ${e.message}`, { title: 'verify-audio falló', priority: 'default', tags: 'warning' }).catch(() => {});
        resolve(false);
      });
      child.on('exit', (code) => {
        closeLogFd();
        if (code !== 0) {
          console.log(`  ⚠️ verify-audio.js terminó con código ${code}. Ver: ${logPath}`);
          notify(
            `⚠️ verify-audio.js terminó con error (código ${code}). Revisá: ${logPath}`,
            { title: 'verify-audio falló', priority: 'default', tags: 'warning' }
          ).catch(() => {});
        }
        resolve(code === 0);
      });
    } catch (e) {
      console.log(`  ⚠️ No se pudo iniciar verify-audio.js: ${e.message}`);
      resolve(false);
    }
  });
}

// stdin se mantiene 'inherit' (los scripts hijo tienen sus propios prompts
// interactivos — pauseForHumanInteraction espera un ENTER, y algunos leen
// input directamente — necesitan la terminal real, no un pipe). stdout/stderr
// van por 'pipe' para poder copiarlos al log unificado (ver RUN_LOG_PATH
// arriba) mientras se siguen mostrando en la terminal igual que con 'inherit'.
function runScript(scriptNameWithArgs) {
  return new Promise((resolve, reject) => {
    const parts = scriptNameWithArgs.split(/\s+/);
    const child = spawn('node', parts, { cwd: __dirname, stdio: ['inherit', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      writeToRunLog(chunk);
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      writeToRunLog(chunk);
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else {
        const err = new Error(`${parts[0]} terminó con código ${code}`);
        if (code === 2) err.noSong = true; // código 2 = cola vacía (ver flow-helpers.js)
        reject(err);
      }
    });
    child.on('error', reject);
  });
}


let cachedBrowser = null;
async function getBrowser() {
  if (!cachedBrowser || !cachedBrowser.isConnected()) {
    cachedBrowser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`, { noDefaults: true });
  }
  return cachedBrowser;
}

async function withCdp(fn) {
  const browser = await getBrowser();
  return await fn(browser);
}

async function checkSunoLoginOnce() {
  return withCdp(async (browser) => {
    const contexts = browser.contexts();
    if (contexts.length === 0) return false;
    const context = contexts[0];
    const pages = context.pages();
    const page = pages.find((p) => p.url().includes('suno.com')) || (pages.length > 0 ? pages[0] : null);
    if (!page) return false;
    return isLoggedIn(page);
  });
}

async function waitUntilSunoLoggedIn() {
  const start = Date.now();
  while (Date.now() - start < LOGIN_WAIT_TIMEOUT_MS) {
    if (await checkSunoLoginOnce()) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('Tiempo agotado esperando el login manual de Suno (5 minutos).');
}

// Verifica si la sesión de Suno está activa, con retry+reload para el caso en
// que la página cargue mal (pantalla negra, skeleton, o i18n keys sin resolver).
//
// Espera un indicador definitivo: [data-testid="lyrics-textarea"] (formulario
// presente = logueado) o un enlace/botón con texto "Sign in" (no logueado).
// Si ninguno aparece en 10 segundos → la página no cargó bien → reload y reintento.
// Máximo maxAttempts en total; si se agotan sin estado definitivo devuelve false
// para que el caller entre en el wait de login manual.
//
// Usa [data-testid="lyrics-textarea"] como sentinel en vez del botón "Create"
// porque data-testid no depende de traducciones — es estable aunque Suno
// renderice i18n keys crudas (ej: "createForm.createButton") en el texto visible.
async function checkSunoSessionReady(maxAttempts = 3) {
  return withCdp(async (browser) => {
    const contexts = browser.contexts();
    if (contexts.length === 0) return false;
    const context = contexts[0];
    const pages = context.pages();
    let page = pages.find((p) => p.url().includes('suno.com')) || (pages.length > 0 ? pages[0] : await context.newPage());
    await page.bringToFront();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Asegurar que estamos en /create — la única vista que muestra el formulario
      // o el sign-in de forma inequívoca.
      if (!page.url().includes('suno.com/create')) {
        await page.goto('https://suno.com/create', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);
      }

      // Esperar hasta 10s a que aparezca un elemento definitivo.
      // Si se agota el timeout la página no cargó bien → reload y reintento.
      let definitive = true;
      try {
        await page.waitForFunction(
          (lyricsSelector) =>
            !!document.querySelector(lyricsSelector) ||
            Array.from(document.querySelectorAll('a, button')).some((el) =>
              /^sign in$/i.test(el.textContent.trim())
            ),
          LYRICS_TEXTAREA,
          { timeout: 10000 }
        );
      } catch {
        definitive = false;
      }

      if (definitive) {
        // Estado definitivo alcanzado — determinar cuál ganó.
        const hasForm = (await page.locator(LYRICS_TEXTAREA).count()) > 0;
        return hasForm; // true = logueado, false = no logueado
      }

      // Página no cargó bien — reload y reintento.
      if (attempt < maxAttempts) {
        console.log(
          `[Paso 2/4] Suno no cargó bien, recargando página (intento ${attempt}/${maxAttempts})...`
        );
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
      } else {
        console.log(
          '[Paso 2/4] Suno no respondió después de varios reloads — asumiendo que puede necesitar login.'
        );
      }
    }

    return false; // fallback: entrar en wait de login manual
  });
}

// Reusa el Chrome del puerto de debug, ubica/abre la tab del Flow, y usa el
// helper compartido para garantizar que haya una asignación activa (#lyrics).
async function openFlowTabAndEnsureAssignment() {
  await withCdp(async (browser) => {
    const contexts = browser.contexts();
    if (contexts.length === 0) throw new Error("No hay contextos de navegador disponibles");
    const context = contexts[0];
    let page = context.pages().find((p) => p.url().includes('cancioneterna.com'));
    const openedNew = !page;
    if (!page) page = await context.newPage();
    await page.bringToFront();

    try {
      const result = await enterFlowAndEnsureAssignment(page, clickByText, { navigate: openedNew });
      console.log(`  Flow listo (${result.assigned}).`);
    } catch (e) {
      if (openedNew) await page.close().catch(() => {});
      throw e;
    }
  });
}

// ─── Helpers del modo --poll ──────────────────────────────────────────────────

function launchPollerChrome() {
  spawn(
    CHROME_PATH,
    [
      `--user-data-dir=${USER_DATA_DIR}`,
      `--profile-directory=${PROFILE_DIRECTORY}`,
      `--remote-debugging-port=${POLL_PORT}`,
      FLOW_URL,
    ],
    { detached: true, stdio: 'ignore' }
  ).unref();
}

// Un ciclo de poll: conecta al Chrome del poller, intenta asegurar asignación.
// Devuelve { found: true, title } si agarró una canción, { found: false } si la cola está vacía.
async function pollOnce(log) {
  return await withCdp(async (browser) => {
  try {
    const contexts = browser.contexts();
    if (contexts.length === 0) return { found: false };
    const ctx = contexts[0];
    let page = ctx.pages().find((p) => p.url().includes('cancioneterna.com'));
    const openedNew = !page;
    if (!page) {
      page = await ctx.newPage();
    } else {
      // Bug real (2026-07-04, ver LESSONS.md): en sequía (cola vacía) esta
      // pestaña quedaba abierta sin cerrar NI recargar — el siguiente poll la
      // reutilizaba tal cual (navigate:false más abajo lee el DOM as-is), así
      // que si una canción nueva caía en la cola mientras tanto, el poller
      // nunca la iba a ver: seguía mirando la misma foto vieja del DOM para
      // siempre. Recargar SIEMPRE que se reutiliza la pestaña garantiza
      // estado fresco en cada intento, sin cambiar el resto del flujo.
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    if (openedNew) {
      await page.bringToFront();
    }

    if (page.url().includes('/sign-in')) {
      log('⚠️ El Flow pide login. Iniciá sesión en la ventana del poller y va a seguir solo.');
      if (openedNew) await page.close().catch(() => {});
      return { found: false };
    }

    try {
      const result = await enterFlowAndEnsureAssignment(page, clickByText, { navigate: openedNew });
      if (result.entered !== true) {
        if (openedNew) await page.close().catch(() => {});
        return { found: false };
      }
      let title = null;
      try { title = (await page.locator('#title').inputValue()).trim() || null; } catch {}
      await page.close().catch(() => {});
      return { found: true, title };
    } catch {
      // enterFlowAndEnsureAssignment tira si no hay #lyrics NI botón Assign utilizable.
      // En sequía lo normal es que Assign no traiga nada: cola vacía, no error fatal.
      if (openedNew && !page.url().includes('cancioneterna.com')) {
        await page.close().catch(() => {});
      }
      return { found: false };
    }
  } catch (err) {
    // Error de conexión/CDP (ej. el browser cacheado se desconectó a mitad de
    // poll) — antes burbujeaba hasta el catch de runPoll y quedaba logueado;
    // withCdp lo intercepta acá, así que lo logueamos nosotros para no perder
    // visibilidad de fallos recurrentes.
    log(`⚠️ Error en pollOnce (no fatal, reintento luego): ${err.message}`);
    return { found: false };
  }
  });
}

// ─── Extracción de tiempo desde "Recent completions" ─────────────────────────

// Parsea "26 min session", "1h 5min session", "26min", etc.
// parseSessionTime vive en lib/session-time.js (extraída de acá para poder
// testearla sin requerir este archivo, que no es un módulo — corre su
// pipeline entero al cargarse).

// Playwright no expone una clase común para distinguir Page de Frame en runtime:
// un Frame tiene goto()/evaluate() igual que Page, pero NO tiene isClosed(),
// reload(), mouse ni screenshot(). Usamos la ausencia de isClosed como firma.
function isPlaywrightFrame(obj) {
  return !!obj && typeof obj.goto === 'function' && typeof obj.evaluate === 'function' && typeof obj.isClosed !== 'function';
}

// Conecta al Chrome del puerto de debug, navega a /artists/flow/create y extrae
// la primera card de "Recent completions": título, texto de sesión, time y screenshot.
// Lanza si no puede conectar, si el DOM no tiene la sección, si el título no
// coincide con expectedTitulo (cuando se pasa), o si el tiempo no se puede parsear.
// El screenshot falla sin lanzar (error logueado, screenshotPath queda null).
//
// options.page: pestaña (Page) o iframe de monitoreo (Frame) a reutilizar. El
// loop de auto-detección del Submit la pasa SIEMPRE — sin esto, cada poll
// navegaba/recargaba la MISMA pestaña donde Hector está por hacer click en
// "Submit to QA" (cada 5s), lo que puede robarle el click o interrumpir el
// formulario. Con un target dedicado en background, la pestaña de trabajo
// nunca se navega.
async function readRecentCompletion(expectedTitulo, { page: providedPage = null } = {}) {
  if (!(await isPortUp(DEBUG_PORT))) {
    throw new Error(`Chrome no está en el puerto ${DEBUG_PORT}`);
  }

  return withCdp(async (browser) => {
    const contexts = browser.contexts();
    if (contexts.length === 0) throw new Error("No hay contextos de navegador disponibles");
    const context = contexts[0];

    const frameMode = isPlaywrightFrame(providedPage);
    let page = providedPage && (frameMode || !providedPage.isClosed())
      ? providedPage
      : context.pages().find((p) => p.url().includes('cancioneterna.com'));
    const openedNew = !page;
    if (!page) page = await context.newPage();
    const rootPage = frameMode ? page.page() : page;

    try {
      // Navegar / refrescar a /create (la vista que muestra "Recent completions")
      if (!page.url().includes('/artists/flow/create')) {
        await page.goto(FLOW_CREATE_URL, { waitUntil: 'domcontentloaded' });
      } else if (!frameMode) {
        await page.reload({ waitUntil: 'domcontentloaded' });
      } else {
        // Frame no tiene reload(). Disparar location.reload() desde adentro del
        // propio frame casi siempre tira "Execution context was destroyed" en
        // Playwright/CDP porque Chromium destruye el realm de JS ANTES de que
        // la respuesta del evaluate() vuelva — no es un error real, la
        // navegación sí ocurre igual. Se traga acá (no en el call site) porque
        // pasa en la inmensa mayoría de los polls, no es una excepción rara.
        await page.evaluate(() => window.location.reload()).catch(() => {});
        await page.waitForLoadState('domcontentloaded').catch(() => {});
      }
      await page.waitForSelector('h3:has-text("Recent completions")', { timeout: 15000 });
      // Optimización de ejecución AGY: Asegura que React renderizó las cards de completados antes de evaluate
      await page.waitForSelector('.rounded-xl:has(.font-medium.text-slate-900)', { timeout: 10000 });
      await page.waitForTimeout(500);

      // Extraer título, texto de sesión e índice global de la primera card
      const cardData = await page.evaluate(() => {
        const heading = Array.from(document.querySelectorAll('h3')).find(
          (el) => /recent completions/i.test(el.textContent)
        );
        if (!heading) return { error: 'heading h3 not found' };

        // Subir hasta encontrar el panel que contiene las cards
        let panel = heading.parentElement;
        for (let i = 0; i < 6; i++) {
          if (!panel) return { error: 'panel not found' };
          if (panel.querySelectorAll('.rounded-xl').length >= 2) break;
          panel = panel.parentElement;
        }

        // Buscar la primera card ignorando si está activa o no (Suno le quita border-slate-100 si está sonando)
        const firstCard = Array.from(panel.querySelectorAll('.rounded-xl')).find(el => el.querySelector('.font-medium.text-slate-900'));
        if (!firstCard) return { error: 'first card not found inside panel' };

        const titleEl = firstCard.querySelector('.font-medium.text-slate-900');
        const metaDiv = firstCard.querySelector('.text-xs.text-slate-500');
        const spans = metaDiv ? Array.from(metaDiv.querySelectorAll('span')) : [];
        // Acepta "Xh Ymin", "Y min" y también horas exactas sin minutos
        // ("1h session", "2 hours session") — sin la tercera alternativa,
        // una sesión de exactamente N horas nunca matchea acá (queda
        // sessionText null) y parseSessionTime()'s hourOnly branch (pensado
        // justo para ese caso) nunca llega a ejecutarse.
        const sessionSpan = spans.find((s) => /\d+\s*(h\s*\d*\s*min|min|h(?:r|our)?s?\b)/i.test(s.textContent));

        // Índice global para usarlo como nth() en Playwright (ignorando colores de borde)
        const allCards = Array.from(document.querySelectorAll('.rounded-xl')).filter(el => el.querySelector('.font-medium.text-slate-900'));
        const cardIndex = allCards.indexOf(firstCard);

        return {
          title: titleEl?.textContent.trim() ?? null,
          sessionText: sessionSpan?.textContent.trim() ?? null,
          cardIndex,
        };
      });

      if (cardData.error) throw new Error(`DOM: ${cardData.error}`);
      if (!cardData.title) throw new Error('No se encontró el título en la primera card');
      if (!cardData.sessionText) throw new Error('No se encontró texto de sesión en la primera card');

      // Verificar que el título coincide con el state.json actual. Usa la
      // `normalize` centralizada de lib/audio-match.js (importada arriba) en
      // vez de una copia local — esa SÍ limpia signos de puntuación
      // (`.replace(/[^a-z0-9\s]/g, ' ')`), la copia local no. Bug real
      // (2026-07-04, ver LESSONS.md): un título con puntuación (ej. "Mi lugar
      // seguro." con punto final) que Suno renderizara sin ese punto en la
      // card fallaba esta comparación por una simple diferencia de puntuación,
      // no una canción distinta — abortaba el auto-registro en Sheets sin
      // necesidad.
      if (expectedTitulo) {
        if (normalize(cardData.title) !== normalize(expectedTitulo)) {
          throw new Error(
            `Título de la card ("${cardData.title}") no coincide con state.json ("${expectedTitulo}"). ` +
            '¿Se completó otra canción antes de registrar esta?'
          );
        }
      } else {
        console.log(`  ⚠️ state.json no tiene título — primera card sin verificar: "${cardData.title}"`);
      }

      // Parsear el tiempo de sesión
      const parsed = parseSessionTime(cardData.sessionText);
      if (!parsed) throw new Error(`No se pudo parsear tiempo: "${cardData.sessionText}"`);

      // Screenshot de la card (fallo no es crítico)
      let screenshotPath = null;
      try {
        fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
        const cardLocator = page.locator('.rounded-xl').filter({ has: page.locator('.font-medium.text-slate-900') }).nth(cardData.cardIndex);
        await cardLocator.scrollIntoViewIfNeeded();
        await page.waitForTimeout(250);
        await rootPage.mouse.move(0, 0);
        await page.waitForTimeout(50);
        
        const cardHandle = await cardLocator.elementHandle();

        // Calcular la caja exacta (bounding box) que envuelve al título y a la info de sesión
        // para tomar la foto estrictamente de ese pedazo, tal como lo pidió el usuario.
        const clipBox = await cardHandle.evaluate((card) => {
          const title = card.querySelector('.font-medium.text-slate-900');
          const meta = card.querySelector('.text-xs.text-slate-500');
          if (!title || !meta) return null;
          
          const tBox = title.getBoundingClientRect();
          const mBox = meta.getBoundingClientRect();
          
          // Unir ambas cajas y darle un pequeño margen
          const top = Math.min(tBox.top, mBox.top) - 12;
          const left = Math.min(tBox.left, mBox.left) - 16;
          const right = Math.max(tBox.right, mBox.right) + 16;
          const bottom = Math.max(tBox.bottom, mBox.bottom) + 12;
          
          return {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top
          };
        });

        // El iframe oculto de monitoreo (poll-iframe-hidden) vive con opacity: 0.01
        // Y z-index: -9999 para quedar invisible/inerte para Hector (ver pollOnce/
        // enterFlowAndEnsureAssignment). Cualquier screenshot — sea
        // rootPage.screenshot({clip}) o locator.screenshot() — captura los píxeles
        // YA COMPUESTOS de la página. Verificado en vivo (probando contra la card
        // real): con SOLO subir la opacidad la foto sigue saliendo en blanco,
        // porque el z-index negativo lo deja renderizado detrás del fondo opaco
        // de la página — hace falta subir AMBOS a la vez para que se vea. Los
        // subimos justo durante el instante del screenshot y los restauramos
        // enseguida — dura ~200ms dentro de un iframe con pointer-events:none,
        // así que no genera flash perceptible ni roba foco.
        const origIframeStyle = frameMode
          ? await rootPage.evaluate(() => {
              const el = document.getElementById('poll-iframe-hidden');
              if (!el) return null;
              const orig = { opacity: el.style.opacity, zIndex: el.style.zIndex };
              el.style.opacity = '1';
              el.style.zIndex = '999999';
              return orig;
            })
          : null;

        // La restauración va en un finally: si el screenshot lanza, el catch de
        // afuera lo trata como "no crítico" y sigue — pero sin esto el iframe
        // quedaba visible (opacity 1, z-index 999999) tapando la pestaña de
        // trabajo de Hector hasta el siguiente poll.
        let imgBuffer;
        try {
          imgBuffer = await (clipBox ? rootPage.screenshot({ clip: clipBox }) : cardLocator.screenshot({ animations: 'disabled' }));
        } finally {
          if (frameMode) {
            await rootPage.evaluate((orig) => {
              const el = document.getElementById('poll-iframe-hidden');
              if (el) {
                el.style.opacity = (orig && orig.opacity) || '0.01';
                el.style.zIndex = (orig && orig.zIndex) || '-9999';
              }
            }, origIframeStyle).catch(() => {});
          }
        }


        const slug = cardData.title
          .toLowerCase()
          .normalize('NFD').replace(/[̀-ͯ]/g, '')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
        const d = new Date();
        const datePrefix = [
          d.getFullYear(),
          String(d.getMonth() + 1).padStart(2, '0'),
          String(d.getDate()).padStart(2, '0'),
        ].join('-');
        screenshotPath = path.join(SCREENSHOTS_DIR, `${datePrefix}_${slug}.png`);
        fs.writeFileSync(screenshotPath, imgBuffer);

        const w = clipBox ? Math.round(clipBox.width) : '?';
        const h = clipBox ? Math.round(clipBox.height) : '?';
        console.log(`  Screenshot: ${screenshotPath} (${w}×${h}px)`);
      } catch (e) {
        console.log(`  ⚠️ Screenshot fallido (no es crítico): ${e.message}`);
      }

      return {
        title: cardData.title,
        sessionText: cardData.sessionText,
        screenshotPath,
        ...parsed,
      };
    } finally {
      if (openedNew && !page.isClosed()) {
        await page.close().catch(() => {});
      }
    }
  });
}

// ─── MODO --done: cierre del flujo ────────────────────────────────────────────
async function runDone(passedCompletion = null) {
  const { logSongToSheet, SPREADSHEET_ID } = require('./lib/sheets-core');

  console.log('=== Cierre (--done): registrando en la hoja ===\n');

  const current = state.read();
  if (current) {
    console.log(`Canción activa según state.json: "${current.titulo}" (${current.songId}), etapa: ${current.stage}`);
  } else {
    console.log('⚠️ No hay state.json. Registrando lo que haya en song.txt de todas formas.');
  }

  // Intentar leer tiempo de sesión y screenshot desde "Recent completions"
  let timeHHMM = null;
  let totalTimeDecimal = null;
  let screenshotPath = null;
  
  if (passedCompletion) {
    timeHHMM = passedCompletion.timeHHMM;
    totalTimeDecimal = passedCompletion.totalTimeDecimal;
    screenshotPath = passedCompletion.screenshotPath;
    console.log(`  ✅ ${passedCompletion.sessionText} → ${timeHHMM} (${totalTimeDecimal} decimal)`);
  } else {
    console.log('\nLeyendo tiempo de sesión desde Recent completions...');
    try {
      const completion = await readRecentCompletion(current?.titulo ?? null);
      timeHHMM = completion.timeHHMM;
      totalTimeDecimal = completion.totalTimeDecimal;
      screenshotPath = completion.screenshotPath;
      console.log(`  ✅ ${completion.sessionText} → ${timeHHMM} (${totalTimeDecimal} decimal)`);
    } catch (e) {
      console.log(`  ⚠️ ${e.message}`);
      console.log('  Total Time y Time quedan vacíos — llenálos a mano en la hoja.');
    }
  }

  const result = await logSongToSheet({ timeHHMM, totalTimeDecimal });

  if (result.written) {
    if (current && current.songId !== result.songId) {
      console.log(
        `\n⚠️ OJO: registré "${result.songId}" pero state.json tenía "${current.songId}". ` +
          'Verificá que registraste la canción correcta.'
      );
    }
    state.write({ songId: result.songId, titulo: result.titulo, stage: state.STAGES.COMPLETED });
    console.log('\n✅ Canción registrada y marcada como completada.');

    // ── Pieza 8: screenshot → Drive (intento; fallback a aviso manual) ──────
    // Anti-duplicado: si --done se corre dos veces para la MISMA canción (ej.
    // reintento manual tras un corte), ya subimos un screenshot nuevo a Drive
    // Y encolamos/enviamos la galería la primera vez — repetirlo generaría
    // otro archivo en Drive y otra foto flotante superpuesta en la misma fila
    // (bug real visto en pruebas: correr --done 2 veces dejó 2 fotos en la
    // fila 173). Si ya se intentó para este songId, no se reintenta acá — un
    // envío que quedó en cola se reintenta solo (flushPendingGalleryUploads
    // al próximo arranque de start-flow.js), nunca a mano desde --done.
    let screenshotAutoPasted = false;
    const alreadyAttempted = current
      && current.galleryAttempt
      && current.galleryAttempt.songId === result.songId;

    if (alreadyAttempted) {
      console.log(
        current.galleryAttempt.sent
          ? '📸 Screenshot de esta canción ya se envió a la galería antes — no se reintenta.'
          : '📸 Screenshot de esta canción ya se encoló antes — se reintentará solo (no acá, para no duplicar en Drive).'
      );
    } else if (screenshotPath) {
      const fileId = await tryDriveScreenshot(screenshotPath, result.row, result.tabName).catch(() => null);

      if (fileId) {
        // ── Pieza 8b: pegar screenshot flotante usando Apps Script Web App ──────
        try {
          const success = await postImageToGallery({
            tabName: result.tabName,
            fileId,
            fila: result.row,
            secret: process.env.GALLERY_WEBAPP_SECRET,
            url: process.env.GALLERY_WEBAPP_URL
          });
          if (success) {
            screenshotAutoPasted = true;
          }
        } catch (e) {
          console.log(`⚠️ postImageToGallery falló y propagó error (${e.message}).`);
        }

        state.write({ galleryAttempt: { songId: result.songId, sent: screenshotAutoPasted } });

        // Si no se pudo pegar automáticamente por Web App (error de red y quedó encolada, o no hay URL)
        if (!screenshotAutoPasted) {
          const { copyImageToClipboard } = require('./lib/sheets-paste');
          if (copyImageToClipboard(screenshotPath)) {
            console.log(`📋 ¡FOTO COPIADA AL PORTAPAPELES como respaldo!`);
            console.log(`   Solo ve a tu Excel, haz click donde la quieras poner y presiona Ctrl+V.\n`);
          }
        }
      } else {
        // Fallback a portapapeles si falló la subida a Drive
        const { copyImageToClipboard } = require('./lib/sheets-paste');
        if (copyImageToClipboard(screenshotPath)) {
          console.log(`📋 ¡FOTO COPIADA AL PORTAPAPELES!`);
          console.log(`   Solo ve a tu Excel, haz click donde la quieras poner y presiona Ctrl+V.\n`);
        }
      }
    }

    const pending = [];
    if (!timeHHMM) pending.push('Total Time', 'Time');
    if (!result.remark) pending.push('Remarks');
    if (!screenshotAutoPasted) pending.push('Flow Screenshot');

    if (screenshotPath) {
      console.log(`📸 Screenshot local: ${screenshotPath}`);
    }
    console.log(`⏱️  Te queda a mano en la hoja: ${pending.join(', ')}.`);

    if (result.remark) {
      console.log(`📝 Remarks auto-completado: "${result.remark}"`);
    } else {
      // ── Pieza 9: remark draft (solo muestra, no escribe) ────────────────────
      const remarkDraft = buildRemarkDraft();
      console.log('\n📝 Borrador de Remarks (no se escribe solo — copialo si querés usarlo):');
      console.log(`   "${remarkDraft}"`);
    }

    // ── Higiene: rotar logs/ y screenshots/ de más de 30 días ───────────────
    // Solo al final de una corrida exitosa (acá, no en --dry-run). Best-effort:
    // nunca debe interrumpir el cierre de la canción ya registrada.
    try {
      rotateOldRunFiles();
    } catch (e) {
      console.warn(`⚠️  Higiene de logs/screenshots falló (no crítico): ${e.message}`);
    }

  } else if (result.reason === 'duplicate') {
    console.log('\n(No se registró de nuevo — ya estaba en la hoja.)');
  }
}

// Genera un borrador de remark leyendo las advertencias de song.txt.
function buildRemarkDraft() {
  try {
    if (!fs.existsSync(path.join(__dirname, 'song.txt'))) return 'Sin novedades.';
    const content = fs.readFileSync(path.join(__dirname, 'song.txt'), 'utf-8');
    const advertMatch = content.match(/\*\*Advertencias:\*\*\s*([\s\S]+?)(?=NOTES:|$)/i);
    if (!advertMatch) return 'Sin novedades.';
    const advert = advertMatch[1].trim().replace(/\s+/g, ' ');
    if (!advert) return 'Sin novedades.';
    // Recortar a máximo 200 chars para que quepa en una celda de la hoja
    return advert.length > 200 ? advert.substring(0, 197) + '...' : advert;
  } catch {
    return 'Sin novedades.';
  }
}

// Sube el screenshot a la carpeta compartida de Drive. A propósito NO escribe
// nada en la hoja (columna H queda vacía) — Hector prefiere pegar la foto él
// mismo "flotando sobre las celdas" en vez de un =IMAGE() automático. Falla
// silenciosamente si faltan credenciales o el upload falla; el screenshot
// local y el registro en la hoja ya se hicieron antes de llegar acá.
async function tryDriveScreenshot(localPngPath, sheetRow, tabName) {
  if (!fs.existsSync(localPngPath)) return;
  const { google } = require('googleapis');
  const CRED_PATH = path.join(__dirname, 'oauth-credentials.json');
  const TOKEN_PATH = path.join(__dirname, 'token.json');

  if (!fs.existsSync(CRED_PATH) || !fs.existsSync(TOKEN_PATH)) return;

  try {
    const creds = JSON.parse(fs.readFileSync(CRED_PATH, 'utf-8'));
    const { client_secret, client_id, redirect_uris } = creds.installed;
    const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0] || 'http://localhost');
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    auth.setCredentials(token);

    const drive = google.drive({ version: 'v3', auth });

    console.log('\n📸 Subiendo screenshot a tu Google Drive personal...');
    const uploadRes = await drive.files.create({
      requestBody: {
        name: path.basename(localPngPath),
        mimeType: 'image/png',
        parents: ['1SDAJlJyXUQG_6sYbWNRDR_PH-Ol5iW4a'] // "Screenshots Flow" compartida
      },
      media: {
        mimeType: 'image/png',
        body: fs.createReadStream(localPngPath),
      },
      fields: 'id, webViewLink, webContentLink',
    });

    const fileId = uploadRes.data.id;
    // Hacer el archivo públicamente legible
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    console.log(`  ✅ Screenshot subido a tu Drive (Screenshots Flow). Puedes insertarlo manualmente sobre las celdas en tu hoja.`);
    return fileId;
  } catch (e) {
    console.log(`  ⚠️ Upload fallido (${e.message.substring(0, 80)}). Pega el screenshot manualmente en col H.`);
    return null;
  }
}

// ─── MODO normal: flujo completo ──────────────────────────────────────────────
// Con resume=true retoma un pipeline cortado usando state.json: salta los pasos
// cuya etapa ya quedó registrada. El caso ambiguo es un crash después de
// suno-fill: no sabemos si Create llegó a clickearse, y un Create doble gasta
// créditos de Suno — por eso en resume NUNCA se re-clickea Create; se buscan los
// MP3 en disco con ventana amplia y, si no están, Create/descarga quedan manuales.
async function runFlow({ resume = false } = {}) {
  let resumeStage = null;
  if (resume) {
    const st = state.read();
    if (!st) {
      console.log('⚠️  --resume: no hay state.json — arrancando desde cero.\n');
    } else if (st.stage === state.STAGES.COMPLETED) {
      console.log(`--resume: "${st.titulo}" ya está marcada como completada. Nada que reanudar.`);
      console.log('Para una canción nueva corré: node start-flow.js');
      return;
    } else {
      resumeStage = st.stage;
      console.log(`🔁 --resume: retomando "${st.titulo}" (${st.songId}) desde la etapa "${resumeStage}".\n`);
    }
  }
  const skipGenerate = resumeStage !== null;

  console.log(`📝 Log de esta corrida: ${RUN_LOG_PATH}`);
  console.log('=== Paso 0/4: preflight ===');
  const pre = runPreflight();
  if (!pre.ok) {
    throw new Error('Preflight falló. Resolvé lo de arriba y volvé a correr.');
  }

  if (skipGenerate) {
    console.log('\n=== Paso 1/4: SALTEADO (--resume) — usando song.txt existente ===');
    const SONG_TXT = path.join(__dirname, 'song.txt');
    if (!fs.existsSync(SONG_TXT)) {
      throw new Error('--resume: no existe song.txt — no hay nada que retomar. Corré sin --resume.');
    }
    const { parseTituloFromSongFile } = require('./lib/audio-analysis');
    const songTitulo = parseTituloFromSongFile(fs.readFileSync(SONG_TXT, 'utf-8'));
    const stTitulo = state.read()?.titulo || null;
    if (stTitulo && songTitulo && songTitulo !== stTitulo) {
      throw new Error(
        `--resume: song.txt es de otra canción ("${songTitulo}") — state.json dice "${stTitulo}". ` +
        'No se puede retomar sin riesgo de mezclar canciones. Corré sin --resume.'
      );
    }
    console.log(`  song.txt OK: "${songTitulo || stTitulo}"`);
  } else {
    console.log('\n=== Paso 1/4: generando letra (run.js) ===\n');
    const preRunState = state.read();
    const providerArg = process.argv.find((a) => a.startsWith('--provider='));
    const providerFlag = providerArg ? ` ${providerArg}` : '';
    await runScript(`run.js${providerFlag}`);

    // ── Salvaguarda contra Create duplicado (gasta créditos reales) ─────────
    // run.js siempre resetea state.json a stage "generated" al terminar
    // (startNew()), así que si ANTES de correrlo la MISMA canción ya estaba
    // en "suno-filled"/"flow-filled", es que una corrida anterior se cortó a
    // mitad de camino (ej. falló la descarga y Gabo volvió a correr
    // start-flow.js a mano en vez de --resume) — sin esto, Paso 3/3b
    // re-llenarían Suno y re-clickearían Create sobre una canción que YA
    // tenía versiones generadas, quemando créditos de más (visto en vivo:
    // 2026-07-03, ~110 créditos gastados de más en "Veinte Años Después"
    // entre dos corridas seguidas). COMPLETED no cuenta acá: si la misma
    // canción vuelve a estar asignada después de completada, es un REDO
    // legítimo que sí necesita generar y llenar todo de nuevo.
    const postRunState = state.read();
    if (
      preRunState && postRunState &&
      preRunState.songId === postRunState.songId &&
      (preRunState.stage === state.STAGES.SUNO_FILLED || preRunState.stage === state.STAGES.FLOW_FILLED)
    ) {
      resumeStage = preRunState.stage;
      console.warn(
        `\n⚠️  SALVAGUARDA: "${postRunState.titulo}" (${postRunState.songId}) ya había llegado a la etapa ` +
        `"${resumeStage}" antes de esta corrida — probablemente una corrida anterior se cortó a mitad de ` +
        'camino. Para NUNCA re-clickear Create de más, esta corrida continúa como si fuera --resume desde ' +
        'esa etapa. Si los MP3 no están en disco, Create y descarga quedan manuales (igual que --resume).\n'
      );
      await notify(
        `⚠️ ${postRunState.titulo}: se evitó un Create duplicado — la canción ya estaba en etapa "${resumeStage}". Continuando como --resume.`,
        { title: 'Salvaguarda: Create duplicado evitado', priority: 'default', tags: 'shield' }
      ).catch(() => {});
      state.write({ stage: resumeStage }); // restaurar la etapa real que run.js había pisado a "generated"
    }
  }

  const skipSunoFill = resumeStage === state.STAGES.SUNO_FILLED || resumeStage === state.STAGES.FLOW_FILLED;
  // Solo saltear el llenado del Flow si la canción ya está COMPLETED (subida
  // + registrada). Para cualquier otra etapa, siempre re-abrir y asegurar que
  // el Flow esté lleno para revisión manual — pero no tiene sentido
  // re-rellenar título/letra/notas de una canción que ya se cerró del todo.
  const skipFlowFill = resumeStage === state.STAGES.COMPLETED;

  if (!skipSunoFill || !skipFlowFill) {
    if (await isPortUp(DEBUG_PORT)) {
      console.log('Chrome ya está corriendo en el puerto de debug.');
    } else {
      console.log('Chrome no está en el puerto de debug. Lanzando suno-open-for-login.js...');
      await runScript('suno-open-for-login.js');
      for (let i = 0; i < 20 && !(await isPortUp(DEBUG_PORT)); i++) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!(await isPortUp(DEBUG_PORT))) {
        throw new Error('Chrome no levantó el puerto de debug a tiempo.');
      }
    }
  }

  if (!skipSunoFill) {
    console.log('\n=== Paso 2/4: verificando sesión de Suno ===');
    if (await checkSunoSessionReady()) {
      console.log('Sesión de Suno confirmada.');
    } else {
      console.log('No hay sesión activa en Suno. Iniciá sesión manualmente en la ventana de Chrome (esperando hasta 5 minutos)...');
      await waitUntilSunoLoggedIn();
      console.log('Login detectado.');
    }
  }

  if (skipSunoFill) {
    console.log('\n=== Paso 3/4: SALTEADO (--resume) — el formulario de Suno ya estaba llenado ===');
  } else {
    console.log('\n=== Paso 3/4: llenando formulario de Suno (suno-fill.js) ===\n');
    await runScript('suno-fill.js');
    state.write({ stage: state.STAGES.SUNO_FILLED });
  }

  // Paso 3b: Create automático + esperar generación + descargar MP3s.
  // Se puede saltar con --no-auto-create para volver al flujo manual.
  const noAutoCreate = process.argv.includes('--no-auto-create');
  let mp3sDescargados = false;
  let hayVersionB = false; // si solo se descargó 1 versión, el upload debe ir a la A
  let verifyOk = false;
  let verifyPromise = null; // corre en paralelo con el Paso 4; se espera después

  const isLoopMode = process.argv.includes('--loop');

  if (skipSunoFill) {
    // En resume no sabemos si el crash fue antes o después del click en Create.
    // Re-clickearlo podría gastar créditos por duplicado, así que solo se buscan
    // los MP3 en disco (ventana amplia de 180 min por si pasó un rato).
    console.log('\n=== Paso 3b/4: --resume — buscando MP3s ya descargados (sin re-clickear Create) ===');
    try {
      const { findSunoMp3s } = require('./lib/audio-match');
      const { versionA, versionB } = findSunoMp3s(state.read()?.titulo || null, { recencyMinutes: 180 });
      mp3sDescargados = true;
      hayVersionB = !!versionB;
      console.log(`  ✅ MP3s encontrados: ${versionA.name}${versionB ? ` + ${versionB.name}` : ' (solo 1 versión)'}`);
      if (!process.argv.includes('--no-auto-verify')) {
        console.log('\n  ⏳ Análisis de audio lanzado en paralelo con el Paso 4 (Whisper + demucs)...');
        verifyPromise = runVerifyAudio({ fast: process.argv.includes('--fast-verify') });
      } else {
        console.log('\n  (--no-auto-verify: saltando el análisis automático — corré node verify-audio.js a mano)');
      }
    } catch (e) {
      console.log(`  ⚠️ No se encontraron MP3s en disco: ${e.message}`);
      console.log('  Revisá Suno: si la generación ya corrió, descargá los 2 MP3 a Downloads/suno/');
      console.log('  (o corré node suno-create.js si Create nunca llegó a clickearse).');
      console.log('  El pipeline sigue con los pasos manuales de siempre.');
    }
  } else if (!noAutoCreate) {
    // ✋ Checkpoint humano: el formulario ya está lleno y los screenshots de
    // verificación en disco. Create gasta créditos de Suno — no se clickea
    // sin un ENTER de confirmación (salvo --no-pause o --loop).
    if (!isLoopMode) {
      await checkpoint(
        `Formulario de Suno lleno para "${state.read()?.titulo || '(sin título)'}".\n` +
        'Verificá los screenshots antes de gastar créditos:\n' +
        '  • suno-verify-overview.png (título/estilo/sliders)\n' +
        '  • suno-verify-lyrics-top.png (letra desde Verse 1)',
        'clickear Create en Suno (gasta créditos) y descargar los 2 MP3'
      );
    } else {
      console.log('\n  (Auto-descarga activa por --loop: omitiendo confirmación humana para gastar créditos)');
    }
    console.log('\n=== Paso 3b/4: Create + generación + descarga (suno-create-dl.js) ===');
    console.log('  (Pasá --no-auto-create para saltar este paso y hacer Create a mano)\n');

    // Reintentos si la descarga falla POR COMPLETO (0 archivos — createAndDownload
    // lanza). Bug real (2026-07-04, ver LESSONS.md): si este primer intento
    // fallaba del todo, `mp3sDescargados` quedaba en false para TODA la corrida
    // — eso saltaba ENTERO el Paso 5 (subida automática): el pipeline solo
    // logueaba el error y seguía sin subir nada, dejando lo que hubiera antes
    // en el Flow (en un REDO, la versión vieja ya rechazada por QC) hasta que
    // Gabo lo notara y subiera a mano.
    const MAX_CREATE_RETRIES = 2;
    let createAttempt = 0;
    let createSucceeded = false;
    while (createAttempt <= MAX_CREATE_RETRIES && !createSucceeded) {
      createAttempt++;
      try {
        const { createAndDownload } = require('./lib/suno-create-dl');
        const { versionA, versionB } = await createAndDownload();
        mp3sDescargados = true;
        hayVersionB = !!versionB;
        createSucceeded = true;
        console.log('\n  ✅ Generación y descarga completas.');
        if (versionA) console.log(`     Versión A: ${versionA.path || versionA.label}`);
        if (versionB) console.log(`     Versión B: ${versionB.path || versionB.label}`);

        // Paso 3c: verify-audio.js — se LANZA acá pero se espera DESPUÉS del
        // Paso 4: el análisis (GPU/CPU + filesystem) y flow-submit (navegador)
        // son independientes, así que correrlos en paralelo ahorra 1-4 min.
        // El resultado se lee antes de la recomendación de versión (Paso 5).
        // --no-auto-verify lo saltea; --fast-verify fuerza el modo rápido.
        if (!process.argv.includes('--no-auto-verify')) {
          console.log('\n  ⏳ Análisis de audio lanzado en paralelo con el Paso 4 (Whisper + demucs)...');
          verifyPromise = runVerifyAudio({ fast: process.argv.includes('--fast-verify') });
        } else {
          console.log('\n  (--no-auto-verify: saltando el análisis automático — corré node verify-audio.js a mano)');
        }
      } catch (e) {
        const tituloActual = state.read()?.titulo || '(sin título)';
        if (createAttempt <= MAX_CREATE_RETRIES) {
          console.log(`\n  ⚠️ Create/descarga falló por completo (intento ${createAttempt}/${MAX_CREATE_RETRIES + 1}): ${e.message}`);
          console.log('  Reintentando — re-clickeando Create sobre el mismo formulario (gasta créditos de nuevo)...');
          await notify(
            `⚠️ Create/descarga falló en "${tituloActual}" (intento ${createAttempt}). Reintentando automáticamente...`,
            { title: 'Reintento de Create', priority: 'default', tags: 'arrows_counterclockwise' }
          ).catch(() => {});
        } else {
          console.log(`\n  ⚠️ Create/descarga automático falló ${createAttempt} veces seguidas: ${e.message}`);
          console.log('  Continuando con el resto del pipeline SIN subir nada automáticamente. Create manual disponible con:');
          console.log('    node suno-create.js   (clickea Create)');
          console.log('    node verify-audio.js  (analiza después de descargar)');
          console.log('    node upload-to-flow.js --version A|B   (subida manual)');
          await notify(
            `🛑 Create/descarga falló ${createAttempt} veces seguidas en "${tituloActual}" — necesita intervención manual (node suno-create.js + upload-to-flow.js). No se subió nada automáticamente.`,
            { title: 'Create/descarga falló — acción manual necesaria', priority: 'urgent', tags: 'warning' }
          ).catch(() => {});
        }
      }
    }
  }

  if (skipFlowFill) {
    console.log('\n=== Paso 4/4: SALTEADO (--resume) — el Flow ya estaba llenado ===');
  } else {
    console.log('\n=== Paso 4/4: llenando título/letra/notas en el Flow (flow-submit.js) ===');
    await openFlowTabAndEnsureAssignment();
    await runScript('flow-submit.js');
    state.write({ stage: state.STAGES.FLOW_FILLED });
  }

  // Esperar el análisis que quedó corriendo en paralelo (Paso 3c) antes de
  // recomendar versión. runVerifyAudio nunca rechaza — resuelve false si falló.
  if (verifyPromise) {
    console.log('\n⏳ Esperando a que termine el análisis de audio (corre desde el Paso 3c)...');
    verifyOk = await verifyPromise;
  }

  const REPORT_PATH = path.join(__dirname, 'verify-report.json');
  const currentTitulo = state.read()?.titulo || null;

  // ── Paso 5: Recomendación + Upload automático de la MEJOR versión ──────────
  // Se sube la versión que recomienda verify-report.json (pickBestVersion:
  // duración, letra, clipping, corte abrupto, CLAP...). Solo se confía en el
  // reporte si el análisis de ESTA corrida terminó bien Y el título coincide
  // con state.json — nunca un reporte viejo o de otra canción. Sin reporte
  // confiable: B por defecto (A si solo se descargó una versión).
  if (mp3sDescargados) {
    let versionToUpload = hayVersionB ? 'B' : 'A';
    let uploadReason = hayVersionB
      ? 'sin reporte de análisis confiable — B por defecto'
      : 'solo se descargó una versión';

    if (verifyOk && fs.existsSync(REPORT_PATH)) {
      try {
        const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf-8'));
        // Normalizado (no comparación estricta de strings) — misma razón que
        // readRecentCompletion más arriba: una diferencia de mayúsculas,
        // espacios extra o puntuación entre song.txt/state.json y lo que
        // escribió verify-audio.js no debería tirar el reporte entero (bug
        // real, ver LESSONS.md). El fallback ya existente ("B por defecto")
        // sigue intacto si de verdad no coincide.
        if (currentTitulo && report.titulo && normalize(report.titulo) === normalize(currentTitulo)) {
          const rec = report.recommendation;
          console.log('\n══════════════════════════════════════════════════════');
          console.log(`📊 RECOMENDACIÓN DE AUDIO: Versión ${rec.recommended}`);
          console.log(`   Razón: ${rec.reason}`);
          if (report.reportA) console.log(`   A: ${report.reportA.durationFormatted} — letra ${Math.round((report.reportA.levenshteinScore || 0) * 100)}%${report.reportA.clippingFlag ? ' — ⚠️ clipping' : ''}${report.reportA.abruptCutoff ? ' — ⚠️ corte abrupto' : ''}`);
          if (report.reportB) console.log(`   B: ${report.reportB.durationFormatted} — letra ${Math.round((report.reportB.levenshteinScore || 0) * 100)}%${report.reportB.clippingFlag ? ' — ⚠️ clipping' : ''}${report.reportB.abruptCutoff ? ' — ⚠️ corte abrupto' : ''}`);
          if (rec.scoreB !== null) console.log(`   Puntajes: A=${rec.scoreA}, B=${rec.scoreB}`);
          console.log('══════════════════════════════════════════════════════');
          if (rec.recommended === 'A' || rec.recommended === 'B') {
            versionToUpload = rec.recommended;
            uploadReason = 'recomendada por el análisis de audio';
          }
        } else {
          console.log('\n  ⚠️ verify-report.json es de otra canción — se ignora para elegir versión.');
        }
      } catch (e) {
        console.log(`\n  ⚠️ No se pudo leer verify-report.json (${e.message}) — se ignora.`);
      }
    }

    // ✋ Checkpoint humano: escuchar/decidir antes de que el bot suba nada al
    // Flow. Acá es donde Hector puede cambiar de versión antes de que se pise
    // el campo de archivo (salvo --no-pause).
    await checkpoint(
      `Listo para subir la Versión ${versionToUpload} al Flow (${uploadReason}).\n` +
      (hayVersionB
        ? `Si preferís la otra, después de esta subida corré: node upload-to-flow.js --version ${versionToUpload === 'B' ? 'A' : 'B'}`
        : 'Solo hay una versión descargada.'),
      `subir la Versión ${versionToUpload} al Flow (SIN Submit to QA todavía — eso se dispara después, automático o manual)`
    );
    console.log(`\n🚀 Subiendo automáticamente la Versión ${versionToUpload} al Flow (${uploadReason})...`);
    try {
      await runScript(`upload-to-flow.js --version ${versionToUpload}`);
      state.write({ stage: state.STAGES.FLOW_FILLED });
      console.log(`\n✅ Versión ${versionToUpload} subida al Flow exitosamente.`);
      const otra = versionToUpload === 'B' ? 'A' : 'B';
      if (hayVersionB) {
        console.log(`   (Si preferís la otra: node upload-to-flow.js --version ${otra} — pisa la subida en el Flow.)`);
      }
    } catch (e) {
      console.log(`\n⚠️ La subida automática de la Versión ${versionToUpload} falló: ${e.message}`);
      console.log(`   Podés reintentar subir manualmente con: node upload-to-flow.js --version ${versionToUpload}`);
      await notify(
        `⚠️ La subida automática de la Versión ${versionToUpload} falló: ${e.message}\nReintento manual: node upload-to-flow.js --version ${versionToUpload}`,
        { title: 'Upload al Flow falló', priority: 'high', tags: 'warning' }
      ).catch(() => {});
    }
  } else {
    console.log(
      '\n✅ Letra y formulario completados, pero no se descargaron MP3s en esta corrida.\n' +
        '   Hacé Create en Suno, descargá los MP3 y subilos manualmente con:\n' +
        '     node upload-to-flow.js --version A|B\n'
    );
  }

  // ── Paso final: Auto-detección del Submit to QA y Cierre automático ────────
  // El poll corre sobre una PESTAÑA DEDICADA en background — nunca sobre la
  // pestaña donde Hector hace click en Submit (recargarla cada 5s le robaba el
  // click y podía interrumpir el formulario). La detección exige que el título
  // de la card coincida con state.json: sin título conocido NO se auto-detecta
  // (la primera card sería la canción ANTERIOR y se registraría un cierre falso).
  if (!currentTitulo) {
    console.log('\n⚠️ state.json no tiene título — no se puede auto-detectar el Submit sin riesgo');
    console.log('   de registrar la canción equivocada. Cuando hagas Submit to QA, cerrá con:');
    console.log('   node start-flow.js --done');
    return;
  }

  const startedAtStr = state.read()?.startedAt;
  const startedTime = startedAtStr ? new Date(startedAtStr).getTime() : Date.now();
  // Sin deadline (pedido de Gabo 2026-07-03): la espera del Submit es
  // indefinida — corta solo cuando se detecta el Submit o se cierra Chrome.
  // Fallback manual de siempre: node start-flow.js --done.

  console.log('\n==================================================================');
  console.log('🤖 Auto-Submit ACTIVO. Se enviará automáticamente entre el min 26 y 31.');
  console.log('   Si lo deseas, puedes hacer click en "Submit to QA" manualmente antes.');
  console.log('   (Espera SIN límite: corta al detectar el Submit o si Chrome se cierra.');
  console.log('    Fallback manual: node start-flow.js --done)');
  console.log('==================================================================\n');

  // Monitoreo invisible vía iframe en la misma pestaña de trabajo (no abre otra
  // pestaña ni interrumpe). Si el iframe no se puede armar o el sitio bloquea
  // el framing (X-Frame-Options / CSP frame-ancestors), cae a una pestaña
  // dedicada en background — la técnica vieja, pero preferible a quedarse sin
  // monitoreo en silencio durante 30 min.
  let pollTarget = null; // Frame (iframe) o Page (fallback de pestaña)
  let pollMode = null; // 'iframe' | 'tab'
  let workPage = null;
  try {
    const browser = await getBrowser();
    const ctx = browser.contexts()[0];
    workPage = ctx ? ctx.pages().find((p) => p.url().includes('cancioneterna.com')) : null;

    // Pre-chequeo del botón "Submit to QA" (SOLO verificación — este código
    // JAMÁS lo clickea, Regla Dura #1): confirmar AHORA que existe y está
    // visible, para enterarse de un cambio de UI del Flow al minuto 5 y no
    // descubrirlo al minuto 28 con la ventana encima.
    if (workPage) {
      try {
        const submitBtn = workPage.getByRole('button', { name: /submit to qa|complete song/i }).first();
        const submitVisible = await submitBtn.isVisible({ timeout: 5000 }).catch(() => false);
        if (submitVisible) {
          console.log('  ✅ Pre-chequeo: el botón "Submit to QA" está visible y listo para TU click.');
        } else {
          console.log('  ⚠️ Pre-chequeo: NO se encuentra el botón "Submit to QA" visible en la pestaña del Flow.');
          console.log('     ¿Cambió la UI, falta scrollear, o la asignación no está cargada? Revisalo ANTES de que corra la ventana.');
          await notify(
            '⚠️ Pre-chequeo: no se ve el botón "Submit to QA" en el Flow. Revisá la pestaña antes de que pase la ventana de submit.',
            { title: 'Pre-chequeo Submit falló', priority: 'high', tags: 'warning' }
          ).catch(() => {});
        }
      } catch (e) {
        console.log(`  ⚠️ Pre-chequeo del botón Submit no se pudo ejecutar (${e.message}) — seguí igual, es solo un aviso.`);
      }
    }

    if (workPage) {
      await workPage.evaluate((url) => {
        let iframe = document.getElementById('poll-iframe-hidden');
        if (!iframe) {
          iframe = document.createElement('iframe');
          iframe.id = 'poll-iframe-hidden';
          iframe.name = 'poll-iframe-hidden';
          // Tamaño real (no 1x1): un iframe de 1x1px renderiza su documento
          // interno en un viewport de 1x1, así que cualquier screenshot de
          // una card adentro saldría vacío/recortado. opacity casi nula +
          // z-index negativo + pointer-events:none lo mantiene invisible e
          // inerte para Hector sin sacrificar el layout interno.
          iframe.style.cssText = 'position: fixed; top: 0; left: 0; width: 1280px; height: 900px; border: 0; opacity: 0.01; pointer-events: none; z-index: -9999;';
          document.body.appendChild(iframe);
        }
        iframe.src = url;
      }, FLOW_CREATE_URL);

      // Reintentos cortos (hasta ~10s) en vez de una espera fija de 2s: el
      // frame suele adjuntarse casi al instante, pero un timeout fijo que
      // falle una sola vez apagaría el monitoreo entero sin aviso. Además de
      // encontrar el frame, confirmamos que realmente cargó "Recent
      // completions" — si el sitio bloqueara el framing, el frame existiría
      // pero quedaría en blanco/error para siempre.
      const attachDeadline = Date.now() + 10000;
      while (Date.now() < attachDeadline && !pollTarget) {
        const frame = workPage.frames().find((f) => f.name() === 'poll-iframe-hidden');
        if (frame) {
          const ready = await frame
            .waitForSelector('h3:has-text("Recent completions")', { timeout: 1500 })
            .then(() => true)
            .catch(() => false);
          if (ready) pollTarget = frame;
        }
        if (!pollTarget) await new Promise((r) => setTimeout(r, 300));
      }

      if (pollTarget) {
        pollMode = 'iframe';
      } else {
        console.log('  ⚠️ El iframe de monitoreo no cargó "Recent completions" (¿el sitio bloquea framing?). Cayendo a pestaña dedicada en background...');
        await workPage.evaluate(() => {
          const iframe = document.getElementById('poll-iframe-hidden');
          if (iframe) iframe.remove();
        }).catch(() => {});
      }
    }

    if (!pollTarget) {
      // Última opción: pestaña dedicada (abre una segunda pestaña, pero
      // preferible a no monitorear nada durante 30 min).
      const pollPage = await ctx.newPage();
      await pollPage.goto(FLOW_CREATE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      if (workPage) await workPage.bringToFront().catch(() => {});
      pollTarget = pollPage;
      pollMode = 'tab';
    }
  } catch (e) {
    console.log(`  ⚠️ No se pudo armar el monitoreo automático (${e.message}). Cerrá con --done.`);
  }

  let completion = null;
  const pollIntervalMs = 5000;
  let lastLogTime = 0;
  let notifiedSafe = false;
  let notifiedDanger = false;
  let notifiedSuspend = false;

  const autoSubmitMinutes = 26 + Math.random() * 5; // 26 to 31
  let autoSubmitTriggered = false;

  // ── Candado visual anti-click-accidental ────────────────────────────────
  // Badge en la esquina + Submit atenuado hasta el minuto 25, SIEMPRE en la
  // pestaña de trabajo (workPage — donde Hector clickea; el diff original lo
  // ponía en la pestaña de monitoreo en background, donde nadie lo ve).
  // Fail-open por diseño: si el proceso muere, un F5 de la página lo limpia
  // (los estilos inyectados no sobreviven una recarga ni un re-render de React),
  // y al salir del loop se restaura explícitamente. El candado NO clickea nada.
  let lockInjected = false;
  let lockGreen = false;

  async function setSubmitLock(mode) {
    // mode: 'lock' (rojo, botón atenuado) | 'open' (verde, botón restaurado) | 'remove' (sin badge)
    if (!workPage) return false;
    try {
      await workPage.evaluate((m) => {
        let overlay = document.getElementById('c-lock');
        const submitBtn = Array.from(document.querySelectorAll('button'))
          .find((b) => /submit to qa|complete song/i.test(b.innerText));
        if (m === 'remove') {
          if (overlay) overlay.remove();
          if (submitBtn) {
            submitBtn.style.opacity = submitBtn.dataset.op || '';
            submitBtn.style.pointerEvents = submitBtn.dataset.pe || '';
          }
          return;
        }
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.id = 'c-lock';
          overlay.style.cssText = 'position:fixed;bottom:20px;right:20px;padding:15px 25px;color:white;font-weight:bold;border-radius:8px;z-index:999999;pointer-events:none;';
          document.body.appendChild(overlay);
        }
        if (m === 'lock') {
          overlay.style.backgroundColor = 'rgba(220, 38, 38, 0.9)';
          overlay.innerText = '🔒 AÚN NO (< 25 min)';
          if (submitBtn) {
            if (submitBtn.dataset.op === undefined) submitBtn.dataset.op = submitBtn.style.opacity;
            if (submitBtn.dataset.pe === undefined) submitBtn.dataset.pe = submitBtn.style.pointerEvents;
            submitBtn.style.opacity = '0.5';
            submitBtn.style.pointerEvents = 'none';
          }
        } else { // 'open'
          overlay.style.backgroundColor = 'rgba(22, 163, 74, 0.9)';
          overlay.innerText = '✅ LISTO (AUTO-SUBMIT PRONTO)';
          if (submitBtn) {
            submitBtn.style.opacity = submitBtn.dataset.op || '';
            submitBtn.style.pointerEvents = submitBtn.dataset.pe || '';
          }
        }
      }, mode);
      return true;
    } catch {
      return false; // pestaña navegada/cerrada — no es fatal, el candado es cosmético
    }
  }

  {
    const elapsedSoFar = (Date.now() - startedTime) / 60000;
    if (elapsedSoFar < 25) {
      lockInjected = await setSubmitLock('lock');
      if (lockInjected) console.log('  🔒 Candado visual activo en la pestaña del Flow hasta el minuto 25 (si este proceso muere, un F5 lo quita).');
    } else {
      lockGreen = true;
      lockInjected = await setSubmitLock('open');
    }
  }

  // Keep-alive de sesión: scroll de 1px (ida y vuelta) en la pestaña del Flow
  // cada 5 min, para que la sesión no caduque por inactividad mientras Hector
  // escucha los MP3 y revisa. No toca el formulario, no roba foco, no clickea.
  const KEEP_ALIVE_MS = 5 * 60 * 1000;
  let lastKeepAlive = Date.now();
  const MEMORY_CHECK_MS = 60 * 1000;
  let lastMemoryCheck = Date.now();
  // Failsafe de suspensión: el loop itera cada ~5s — si entre dos vueltas el
  // reloj saltó minutos, la PC se suspendió y el tiempo REAL siguió corriendo.
  let lastLoopTick = Date.now();
  let currentElapsedMin = (Date.now() - startedTime) / 60000;

  if (pollTarget) {
    // Countdown en vivo (cada segundo, en la MISMA línea de terminal con \r).
    // process.stdout.write a propósito: el console.log parchado copia todo al
    // run-log y 1800 líneas de ticker lo inflarían — el estado ya queda
    // registrado con la línea [Timer] de cada 30s.
    const ticker = setInterval(() => {
      const mins = currentElapsedMin;
      let msg;
      if (mins < 25) msg = `⏳ ${mins.toFixed(1)} min — ventana de Submit en ~${(25 - mins).toFixed(1)} min`;
      else if (mins <= autoSubmitMinutes) msg = `✅ ${mins.toFixed(1)} min — Auto-Submit en ~${(autoSubmitMinutes - mins).toFixed(1)} min (o clickealo manual)`;
      else msg = `🤖 ${mins.toFixed(1)} min — Auto-Submit enviado (esperando confirmación)`;
      process.stdout.write(`\r[Countdown] ${msg}      `);
    }, 1000);
    if (typeof ticker.unref === 'function') ticker.unref();

    // Contador de fallos ESTRUCTURALES consecutivos de readRecentCompletion.
    // "Título aún no coincide" es la espera normal (la primera card sigue
    // siendo la canción anterior hasta que Hector hace Submit) y NO cuenta.
    // Pero si el DOM dejó de matchear (Suno/Flow rediseñó las clases Tailwind
    // de "Recent completions"), el loop giraría para siempre en silencio —
    // esto avisa por ntfy sin agregar deadline (el loop sigue infinito por
    // diseño, pedido de Gabo 2026-07-03).
    let consecutiveStructuralErrors = 0;
    let notifiedStructuralErrors = false;
    const STRUCTURAL_ERROR_ALERT_THRESHOLD = 36; // ~3 min a un poll cada 5s

    while (true) {
      let elapsedMin = (Date.now() - startedTime) / 60000;
      const now = Date.now();

      // Intentar sincronizar con el timer de la página del Flow
      if (workPage) {
        try {
          const timerEl = workPage.getByText(/min target/i).first();
          if (await timerEl.isVisible().catch(() => false)) {
            const pageTimerText = await timerEl.innerText().catch(() => '');
            const parsedMin = parseWebpageTimer(pageTimerText);
            if (parsedMin !== null) {
              elapsedMin = parsedMin;
            }
          }
        } catch (e) {
          // Fallback silencioso al local clock si Playwright falla o la pestaña está cerrada
        }
      }
      currentElapsedMin = elapsedMin;

      // Failsafe de suspensión (aviso — el Submit sigue siendo tuyo, así que
      // acá no hay nada que "cancelar": solo enterarte del tiempo real).
      if (now - lastLoopTick > 120000 && !notifiedSuspend) {
        notifiedSuspend = true;
        const jumpMin = ((now - lastLoopTick) / 60000).toFixed(1);
        console.log(`\n⚠️ Salto de reloj detectado (~${jumpMin} min sin ejecutar): la PC parece haberse suspendido.`);
        console.log(`   Tiempo REAL desde la asignación: ${elapsedMin.toFixed(1)} min — tenelo en cuenta antes de tu Submit.`);
        await notify(
          `⚠️ La PC se suspendió ~${jumpMin} min con la canción abierta. Tiempo real: ${elapsedMin.toFixed(1)} min desde la asignación. Revisá antes de hacer Submit.`,
          { title: 'Salto de reloj detectado', priority: 'urgent', tags: 'zzz,warning' }
        ).catch(() => {});
      }
      lastLoopTick = now;

      // Candado visual: pasa a verde y restaura el botón al minuto 25
      if (lockInjected && elapsedMin >= 25 && !lockGreen) {
        lockGreen = true;
        await setSubmitLock('open');
      }

      // Auto-Submit
      if (workPage && elapsedMin >= autoSubmitMinutes && !autoSubmitTriggered) {
        autoSubmitTriggered = true;

        // Salvaguarda: si esta canción es un REDO (QC ya la rechazó una vez
        // en un ciclo anterior — ver state.isRedo, seteado por run.js),
        // NO auto-submitear. Un REDO ya gastó un round-trip de QC; un
        // auto-submit prematuro sobre una corrección puede volver a costar
        // un redo sin cobrar si Gabo todavía no confirmó que el fix quedó
        // bien (motivo original de la vieja Regla Dura #1). Se avisa por
        // ntfy urgent y se deja el Submit en manual para esta canción.
        const currentState = state.read();
        if (currentState?.isRedo) {
          console.log(`\n🛑 [Auto-Submit] SALTEADO: esta canción es un REDO (state.json.isRedo=true). Submit queda manual para este ciclo.`);
          await notify(`🛑 Auto-Submit salteado (REDO) — hacé Submit to QA manualmente cuando confirmes el fix.`, {
            title: `[REDO] ${currentTitulo}`,
            priority: 'high',
            tags: 'warning'
          }).catch(() => {});
        } else {
          console.log(`\n🤖 [Auto-Submit] Alcanzado el umbral aleatorio de ${autoSubmitMinutes.toFixed(1)} min. Enviando Submit to QA...`);
          logAutoSubmitEvent({ event: 'attempt', elapsedMin, autoSubmitMinutes, titulo: currentTitulo });
          try {
            const submitBtn = workPage.locator('button:has-text("Complete Song"), button:has-text("Submit to QA")').first();
            await submitBtn.click({ timeout: 5000 });
            console.log(`  ✅ Clickeado "Submit to QA" / "Complete Song" inicial.`);

            // Buscar el botón de confirmación en el modal y esperar a que sea visible
            // Usamos un text-selector robusto en lugar de getByRole por si el árbol de accesibilidad de React se rompe
            const confirmBtn = workPage.locator('button:has-text("Yes, Complete Song"), button:has-text("Yes, Submit to QA")').first();
            try {
              await confirmBtn.waitFor({ state: 'visible', timeout: 6000 });
              await confirmBtn.click({ timeout: 5000 });
              console.log(`  ✅ Clickeado botón de confirmación modal "Yes, Complete Song" exitosamente.`);
              logAutoSubmitEvent({ event: 'confirmed', elapsedMin, autoSubmitMinutes, titulo: currentTitulo });
            } catch (waitErr) {
              console.log(`  ⚠️ No se detectó botón de confirmación modal ("Yes, Complete Song") tras esperar. Quizás no requiere confirmación o ya se envió.`);
              logAutoSubmitEvent({ event: 'clicked_no_confirm_modal', elapsedMin, autoSubmitMinutes, titulo: currentTitulo });
            }
          } catch (e) {
            console.log(`  ❌ Falló el auto-submit: ${e.message}`);
            logAutoSubmitEvent({ event: 'failed', elapsedMin, autoSubmitMinutes, titulo: currentTitulo, error: e.message });
          }
        }
      }

      // Keep-alive de sesión del Flow
      if (workPage && now - lastKeepAlive >= KEEP_ALIVE_MS) {
        lastKeepAlive = now;
        try {
          await workPage.evaluate(() => { window.scrollBy(0, 1); window.scrollBy(0, -1); });
          console.log(`\n[Keep-alive] Sesión del Flow refrescada (scroll 1px) a los ${elapsedMin.toFixed(1)} min.`);
        } catch {
          // Pestaña cerrada o navegada — el chequeo de puerto de abajo decide si abortar.
        }
      }

      // Memory Supervisor: Cerrar pestañas vacías para cuidar la RAM
      if (now - lastMemoryCheck >= MEMORY_CHECK_MS) {
        lastMemoryCheck = now;
        try {
          const browser = await getBrowser();
          const context = browser.contexts()[0];
          if (context) {
            const pages = context.pages();
            let closedCount = 0;
            for (const p of pages) {
              const u = p.url();
              if (u === 'about:blank' || u === 'chrome://newtab/') {
                await p.close().catch(() => {});
                closedCount++;
              }
            }
            if (closedCount > 0) {
              console.log(`\n🧹 [Memory Supervisor] Cerradas ${closedCount} pestañas vacías ("${closedCount > 1 ? 'varias' : 'una'}") para liberar RAM en Chrome.`);
            }
          }
        } catch (e) {
          // ignore
        }
      }

      // Imprimir el estado del timer en consola cada 30 segundos
      if (now - lastLogTime >= 30000) {
        lastLogTime = now;
        if (elapsedMin < 25) {
          const remainingMin = Math.ceil(25 - elapsedMin);
          console.log(`\n[Timer] ⏳ Transcurrido: ${elapsedMin.toFixed(1)} min. Faltan ~${remainingMin} min para el Submit seguro. NO hagas click todavía.`);
        } else if (elapsedMin < autoSubmitMinutes) {
          const remainingAuto = Math.max(0, autoSubmitMinutes - elapsedMin);
          console.log(`\n[Timer] ✅ ¡TIEMPO SEGURO! Transcurrido: ${elapsedMin.toFixed(1)} min. Podés hacer click manualmente, o auto-submit en ~${remainingAuto.toFixed(1)} min.`);
        } else {
          console.log(`\n[Timer] 🤖 Auto-submit ya debería haberse disparado (Transcurrido: ${elapsedMin.toFixed(1)} min). Esperando confirmación.`);
        }
      }

      // Notificaciones automáticas a ntfy (al celular)
      if (elapsedMin >= 25 && !notifiedSafe) {
        notifiedSafe = true;
        await notify(`✅ Tiempo Seguro (25m) — Ya podés hacer click en Submit.`, {
          title: `[Lista] ${currentTitulo}`,
          priority: 'high',
          tags: 'white_check_mark'
        }).catch(() => {});
      }

      if (elapsedMin >= autoSubmitMinutes + 2 && !notifiedDanger) {
        notifiedDanger = true;
        await notify(`⚠️ Riesgo — Auto-Submit falló o no se detectó. Verificá manualmente.`, {
          title: `[Límite] ${currentTitulo}`,
          priority: 'urgent',
          tags: 'warning'
        }).catch(() => {});
      }

      try {
        completion = await readRecentCompletion(currentTitulo, { page: pollTarget });
        consecutiveStructuralErrors = 0;
        if (completion) break;
      } catch (e) {
        // Título aún no coincide / formulario aún sin enviar — seguir esperando.
        // Pero si Chrome se cerró, no tiene sentido seguir esperando a ciegas.
        if (!(await isPortUp(DEBUG_PORT))) {
          console.log('\n⚠️ Chrome se cerró — la auto-detección no puede continuar.');
          break;
        }
        if (/no coincide con state\.json/.test(e.message || '')) {
          consecutiveStructuralErrors = 0; // espera normal pre-Submit
        } else {
          consecutiveStructuralErrors++;
          if (consecutiveStructuralErrors >= STRUCTURAL_ERROR_ALERT_THRESHOLD && !notifiedStructuralErrors) {
            notifiedStructuralErrors = true;
            console.log(`\n⚠️ readRecentCompletion lleva ${consecutiveStructuralErrors} fallos estructurales seguidos: ${e.message}`);
            console.log('   Posible rediseño de la UI de "Recent completions" — la auto-detección puede no funcionar. Fallback: node start-flow.js --done');
            await notify(
              `⚠️ La auto-detección del Submit lleva ~3 min fallando con el mismo error estructural: ${e.message}\nSi hiciste Submit y no se registró solo, corré: node start-flow.js --done`,
              { title: 'Auto-detección del Submit con problemas', priority: 'high', tags: 'warning' }
            ).catch(() => {});
          }
        }
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    clearInterval(ticker);
    process.stdout.write('\n'); // cerrar la línea del countdown antes de seguir logueando
    if (lockInjected) await setSubmitLock('remove'); // nunca dejar el botón atenuado al salir
    if (pollMode === 'iframe' && workPage) {
      await workPage.evaluate(() => {
        const iframe = document.getElementById('poll-iframe-hidden');
        if (iframe) iframe.remove();
      }).catch(() => {});
    } else if (pollMode === 'tab') {
      await pollTarget.close().catch(() => {});
    }
  }

  if (completion) {
    console.log(`\n✅ ¡Detección automática exitosa!`);
    console.log(`   Canción: "${completion.title}"`);
    console.log(`   Tiempo de sesión: ${completion.sessionText}`);
    await runDone(completion);
  } else {
    console.log('\n⚠️ No se detectó el clic en "Submit to QA" (Chrome se cerró).');
    console.log('   Si ya hiciste el Submit, registra la canción ejecutando:');
    console.log('   node start-flow.js --done');
    await notify(
      'No se auto-detectó el Submit to QA. Si ya lo hiciste, corré: node start-flow.js --done',
      { title: 'Cancion Eterna: cierre pendiente', priority: 'default', tags: 'warning' }
    ).catch(() => {});
  }
}

// ─── MODO --poll: vigía de cola ───────────────────────────────────────────────
// ─── Modo --dry-run: ensayo completo sin gastar nada ─────────────────────────
// Corre run.js con el mock local (cero API de Claude/Gemini), NO toca Chrome,
// Suno ni el Flow (esos pasos se simulan), pero ejercita DE VERDAD las dos
// cosas que hay que poder probar sin una canción real: los checkpoints de
// verificación humana (ENTER) y las notificaciones ntfy (marcadas [DRY-RUN]).
// song.txt se respalda antes y se restaura SIEMPRE al final — el mock jamás
// debe pisar la letra de una canción real en curso (mismo criterio que run.js
// aplica a state.json y a la caché en --dry-run).
async function runDryRun() {
  console.log('🧪 MODO DRY-RUN — ensayo completo: mock local, cero API, cero Chrome/Suno/Flow.');
  console.log(`📝 Log de esta corrida: ${RUN_LOG_PATH}\n`);

  const SONG_TXT = path.join(__dirname, 'song.txt');
  const BACKUP = SONG_TXT + '.dry-run-backup';
  const hadRealSong = fs.existsSync(SONG_TXT);
  if (hadRealSong) {
    fs.copyFileSync(SONG_TXT, BACKUP);
    console.log('🛟 song.txt actual respaldado (se restaura al final del ensayo).\n');
  }

  try {
    console.log('=== Paso 0/4: preflight (informativo — en dry-run no aborta) ===');
    try {
      runPreflight();
    } catch (e) {
      console.log(`  (preflight lanzó "${e.message}" — se ignora en dry-run)`);
    }

    console.log('\n=== Paso 1/4: generando letra MOCK (run.js --dry-run, cero API) ===\n');
    await runScript('run.js --dry-run');

    // Verificación real: el mock tiene que ser parseable por los mismos
    // regex que usan suno-fill.js y flow-submit.js — si esto falla, el
    // pipeline real también fallaría después de gastar la llamada al LLM.
    const mock = fs.readFileSync(SONG_TXT, 'utf-8');
    const mockOk = /\*\*Título:\*\*\s*.+/i.test(mock) && /\[Verse 1\]/i.test(mock) && /\*\*Estilo Suno:\*\*\s*.+/i.test(mock);
    if (!mockOk) throw new Error('El song.txt mock no pasa los parsers de suno-fill/flow-submit.');
    console.log('  ✅ song.txt mock parseable por suno-fill.js y flow-submit.js.');
    await notify('[DRY-RUN] ✅ Letra mock generada y parseada OK. Siguiente: checkpoint de Suno.', {
      title: '[DRY-RUN] Paso 1 completo', priority: 'default', tags: 'test_tube',
    });

    console.log('\n=== Paso 2/4: SIMULADO — sesión de Suno (no se toca Chrome) ===');
    console.log('=== Paso 3/4: SIMULADO — llenado del formulario de Suno ===');
    await checkpoint(
      '[DRY-RUN] Simulación: el formulario de Suno estaría lleno y los screenshots en disco.\n' +
      'En una corrida real acá verificás suno-verify-overview.png y suno-verify-lyrics-top.png.',
      '[DRY-RUN] simular el click en Create (no gasta créditos)'
    );

    console.log('=== Paso 3b/4: SIMULADO — Create + generación + descarga de MP3s ===');
    console.log('=== Paso 3c/4: SIMULADO — verify-audio.js (Whisper/CLAP) ===');
    console.log('=== Paso 4/4: SIMULADO — flow-submit.js (título/letra/notas en el Flow) ===');
    await checkpoint(
      '[DRY-RUN] Simulación: listo para subir la Versión B al Flow (recomendación simulada).',
      '[DRY-RUN] simular la subida del MP3 (no toca el Flow)'
    );

    await notify('[DRY-RUN] 🧪 Ensayo completo OK: letra mock, 2 checkpoints ENTER y notificaciones funcionando.', {
      title: '[DRY-RUN] Pipeline OK', priority: 'default', tags: 'test_tube',
    });
    console.log('\n══════════════════════════════════════════════════════');
    console.log('🧪 DRY-RUN COMPLETO — todo el circuito respondió:');
    console.log('   • run.js generó y validó la letra mock (cero API).');
    console.log(PAUSE_MODE
      ? '   • Los 2 checkpoints de ENTER pausaron y reanudaron (--pause).'
      : '   • Checkpoints desactivados (default) — el flujo corre de un tirón hasta tu Submit. Probálos con --pause.');
    console.log('   • Las notificaciones ntfy se dispararon (revisá el celular).');
    console.log('   • Regla Dura #1 deprecada: en modo normal haría Submit to QA automáticamente.');
    console.log('══════════════════════════════════════════════════════');
  } finally {
    if (hadRealSong) {
      fs.copyFileSync(BACKUP, SONG_TXT);
      fs.unlinkSync(BACKUP);
      console.log('\n🛟 song.txt real restaurado (el mock del ensayo no queda en disco).');
    } else if (fs.existsSync(SONG_TXT)) {
      // No había song.txt antes del ensayo — no dejar un mock con pinta de real.
      fs.unlinkSync(SONG_TXT);
      console.log('\n🧹 song.txt mock eliminado (no había canción en curso antes del ensayo).');
    }
  }
}

async function runPoll(rawArgs) {
  function ts() { return new Date().toLocaleTimeString('es', { hour12: false }); }
  function log(msg) { console.log(`[${ts()}] ${msg}`); }

  const pollIdx = rawArgs.indexOf('--poll');
  const afterPoll = rawArgs[pollIdx + 1];
  // Si el siguiente arg empieza con '-' es otra flag, no el intervalo. Por defecto 10-15s.
  const intervalArg = (afterPoll && !afterPoll.startsWith('-')) ? afterPoll : '10-15s';
  
  let minMs, maxMs, isRange = false, intervalLabel;
  
  if (intervalArg.includes('-')) {
    isRange = true;
    const parts = intervalArg.split('-');
    const minVal = parseFloat(parts[0]);
    const maxPart = parts[1];
    const isSec = maxPart.toLowerCase().endsWith('s');
    const maxVal = parseFloat(maxPart);
    
    const factor = isSec ? 1000 : 60000;
    minMs = minVal * factor;
    maxMs = maxVal * factor;
    intervalLabel = isSec ? `${minVal}-${maxVal}s` : `${minVal}-${maxVal} min`;
  } else {
    const isSeconds = intervalArg.toLowerCase().endsWith('s');
    const val = parseFloat(intervalArg);
    const factor = isSeconds ? 1000 : 60000;
    minMs = val * factor;
    maxMs = val * factor;
    intervalLabel = isSeconds ? `${val}s` : `${val} min`;
  }

  log(`Vigía de cola iniciado. Revisando en rango ${intervalLabel}. (Ctrl+C para detener.)`);
  log(`Log de esta corrida: ${RUN_LOG_PATH}`);

  // Asegurar que haya un Chrome arriba en el puerto 9333 (propio o el de Suno,
  // ahora es el mismo puerto). Si ya está arriba (ej. Suno abierto) no se lanza nada nuevo.
  if (!(await isPortUp(POLL_PORT))) {
    log('Abriendo la ventana de Chrome del poller...');
    launchPollerChrome();
    for (let i = 0; i < 20 && !(await isPortUp(POLL_PORT)); i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!(await isPortUp(POLL_PORT))) {
      log('No se pudo abrir el Chrome del poller a tiempo. Saliendo.');
      process.exit(1);
    }
    // Darle un momento a la página para cargar la primera vez.
    await new Promise((r) => setTimeout(r, 3000));
  }

  // Bucle de polling.
  while (true) {
    let pollResult = { found: false };
    try {
      pollResult = await pollOnce(log);
    } catch (e) {
      log(`Error en el ciclo (no fatal, reintento luego): ${e.message}`);
    }

    if (pollResult.found) {
      log('✅ ¡Canción encontrada y asignada!');

      const body = pollResult.title
        ? `Canción asignada: "${pollResult.title}"`
        : 'Canción asignada y lista para procesar.';
      await notify(body, { title: 'Canción Asignada', priority: 'default', tags: 'musical_note' });

      // Nota: con el puerto unificado (9333) la tab de Suno vive en el MISMO
      // Chrome que usa el poller, así que ya no hay conflicto de perfiles —
      // el viejo chequeo isSunoSessionLive() acá abortaba el pipeline justo
      // en el caso normal (Suno logueado y listo) y se eliminó a propósito.
      log('Arrancando el pipeline...\n');
      await runFlow();
      return; // runFlow() ya loguea el resultado final
    }

    const currentIntervalMs = isRange
      ? Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
      : minMs;
    const nextLabel = (currentIntervalMs / 1000).toFixed(1) + 's';

    log(`Aún no hay canciones. Próximo intento en ${nextLabel}.`);
    await new Promise((r) => setTimeout(r, currentIntervalMs));
  }
}

// ─── Entrada ──────────────────────────────────────────────────────────────────
(async () => {
  // 1. Flush de imágenes pendientes a la galería antes de cualquier otra cosa
  const WEB_APP_URL = process.env.GALLERY_WEBAPP_URL;
  const WEB_APP_SECRET = process.env.GALLERY_WEBAPP_SECRET;
  await flushPendingGalleryUploads({ secret: WEB_APP_SECRET, url: WEB_APP_URL });

  const rawArgs = process.argv.slice(2);

  // Typo guard: "-- done" o "-- poll" (Node los recibe como dos args separados:
  // ['--', 'done'] en vez de ['--done']). join('') los funde igual que si no
  // hubiera espacio, permitiendo detectar el typo antes de que haga daño.
  // Esto fue un bug real en producción: "node start-flow.js -- done" arrancó
  // runFlow() en vez de runDone(), intentó launchPersistentContext con Chrome
  // ya abierto y crasheó con "Opening in existing browser session".
  const reconstituted = rawArgs.join('');
  if (reconstituted === '--done' && !rawArgs.includes('--done')) {
    console.error('❌ Typo detectado: escribiste "--done" con un espacio entre -- y done.');
    console.error('   Usá:  node start-flow.js --done');
    process.exit(1);
  }
  if (reconstituted === '--poll' && !rawArgs.includes('--poll')) {
    console.error('❌ Typo detectado: escribiste "--poll" con un espacio entre -- y poll.');
    console.error('   Usá:  node start-flow.js --poll');
    process.exit(1);
  }

  const isDone = rawArgs.includes('--done');
  const isPoll = rawArgs.includes('--poll');
  const isResume = rawArgs.includes('--resume');
  const isDryRun = rawArgs.includes('--dry-run');
  const isLoop = rawArgs.includes('--loop');

  if (isDone) {
    await runDone();
  } else if (isPoll) {
    await runPoll(rawArgs);
  } else if (isDryRun) {
    await runDryRun();
  } else if (isLoop) {
    // ── Modo --loop: canciones en continuo ──────────────────────────────────
    // Cada ciclo corre el flujo COMPLETO (runFlow ya incluye el cierre: detecta
    // tu Submit manual y registra en Sheets/Drive — por eso acá NO se llama a
    // runDone() de nuevo: hacerlo arriesgaría un registro doble). Sin canciones
    // en cola cae al vigía (runPoll), que al asignar una corre runFlow entero
    // y retorna. Un ciclo que falla avisa por ntfy y el loop sigue con la
    // próxima — solo Ctrl+C (o cerrar Chrome sin reabrir) lo frena.
    // Todo el ciclo funciona de principio a fin sin requerir atención.
    console.log('🔁 Modo --loop: canciones en continuo. Todo el proceso es ahora 100% AUTOMÁTICO (incluso el Submit to QA). Ctrl+C para salir.\n');
    let ciclo = 0;
    while (true) {
      ciclo++;
      try {
        await runFlow({ resume: false });
      } catch (err) {
        if (err.noSong) {
          console.log('\nNo hay canciones en cola — vigía activa (10-15s) hasta que caiga la próxima...\n');
          try {
            await runPoll(['--poll', '10-15s']);
          } catch (pollErr) {
            console.error(`\n❌ --loop: el vigía/pipeline falló: ${pollErr.message}`);
            await notify(
              `❌ --loop: el ciclo ${ciclo} falló (${String(pollErr.message).slice(0, 140)}). Reintento en 60s. Ctrl+C para frenar.`,
              { title: 'Loop: ciclo falló', priority: 'urgent', tags: 'rotating_light' }
            ).catch(() => {});
            await new Promise((r) => setTimeout(r, 60000));
          }
        } else {
          console.error(`\n❌ --loop: el ciclo ${ciclo} falló: ${err.message}`);
          await notify(
            `❌ --loop: el ciclo ${ciclo} falló (${String(err.message).slice(0, 140)}). Reintento con la próxima canción en 60s. Ctrl+C para frenar.`,
            { title: 'Loop: ciclo falló', priority: 'urgent', tags: 'rotating_light' }
          ).catch(() => {});
          await new Promise((r) => setTimeout(r, 60000));
        }
      }
      console.log(`\n🔁 --loop: ciclo ${ciclo} terminado. Buscando la siguiente canción en 5s...`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  } else {
    try {
      await runFlow({ resume: isResume });
    } catch (err) {
      if (err.noSong) {
        console.log('\nNo hay canciones en cola. Entrando en modo poll automático (intervalo: 10-15s)...\n');
        await runPoll(['--poll', '10-15s']);
      } else {
        throw err;
      }
    }
  }

  // Desconectar la conexión CDP cacheada y salir explícitamente: el socket de
  // connectOverCDP mantiene vivo el event loop de Node (verificado en
  // Playwright 1.61) — sin esto el orquestador queda colgado al terminar.
  // browser.close() sobre CDP solo desconecta; Chrome queda abierto.
  // El delay de 250ms antes de exit() evita el mismo crash de libuv en Windows
  // que se vio en run.js (close() + process.exit() en el mismo tick) — ver run.js.
  if (cachedBrowser) await cachedBrowser.close().catch(() => {});
  setTimeout(() => process.exit(0), 250);
})().catch((err) => {
  console.error('Orquestación falló:', err);
  // Aviso push del fallo fatal — notify tiene timeout interno de 8s y nunca
  // rechaza, así que el exit no puede quedar colgado por esto.
  notify(`❌ El pipeline se cayó: ${err.message || err}\nRevisá la terminal y el log: ${RUN_LOG_PATH}\nReanudar: node start-flow.js --resume`, {
    title: 'Pipeline caído', priority: 'urgent', tags: 'rotating_light',
  }).finally(() => process.exit(1));
});
