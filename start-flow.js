// start-flow.js — Orquestador único del pipeline. Un solo comando:
//
//   node start-flow.js                  -> flujo completo: genera letra, llena
//                                          Suno, clickea Create automáticamente,
//                                          espera generación, descarga ambos MP3,
//                                          llena el Flow. Se detiene para que
//                                          Gabo analice y elija versión.
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
//   node start-flow.js --poll [N]       -> vigía de cola: verifica cada N minutos
//                                          (default 3) si cayó una canción.
//                                          Acepta segundos con sufijo "s" (ej: 30s).
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
// 🛑 REGLA DURA #1 — NUNCA hacer Submit to QA automáticamente.
//    Ver CLAUDE.md sección "REGLA DURA". El Submit es siempre manual.
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
//   → STOP. Gabo revisa el resultado de verify-audio.js (o lo corre a mano si
//     se saltéo), elige versión, corre upload-to-flow.js.
//   → Gabo hace Submit to QA manualmente.
//   → node start-flow.js --done registra en la hoja.
//
// run.js cierra su propio Chrome al terminar (perfil compartido con Suno — ver
// LESSONS.md "CDP lifecycle pattern"), así que para los Pasos 3b y 4 reusamos el
// Chrome del puerto de debug (el de Suno) en vez de lanzar uno nuevo.
//
// El modo --poll usa el puerto 9334 (distinto del de Suno, 9333). Antes de lanzar
// el flujo, cierra su Chrome y espera a que el puerto caiga — señal concreta de que
// el proceso murió y el perfil quedó libre. Nunca un sleep fijo. Ver LESSONS.md.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');
const { isLoggedIn, clickByText, isPortUp, ensurePortIsFree } = require('./lib/playwright-helpers');
const { enterFlowAndEnsureAssignment, FLOW_URL } = require('./lib/flow-helpers');
const { runPreflight } = require('./lib/preflight');
const { notify } = require('./lib/ntfy');
const state = require('./lib/pipeline-state');
const { LYRICS_TEXTAREA } = require('./lib/suno-selectors');

const DEBUG_PORT = 9333;   // Chrome de Suno (ya corriendo para suno-fill y flow-submit)
const POLL_PORT  = 9334;   // Chrome propio del modo --poll (se abre y cierra dentro del modo)
const FLOW_CREATE_URL = 'https://cancioneterna.com/artists/flow/create';
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER_DATA_DIR = 'C:\\Users\\hecto\\AppData\\Local\\ChromeAutomationProfile';
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

// Referencia al proceso del QA Dashboard mientras está corriendo, para poder
// matarlo desde el handler de 'exit' si el proceso principal termina de
// golpe (Ctrl+C, excepción no capturada) antes de llegar a su kill() normal
// — si no, queda un servidor Express huérfano escuchando en el puerto 3000.
let activeDashboardProcess = null;

process.on('exit', () => {
  try { fs.closeSync(runLogFd); } catch {}
  if (activeDashboardProcess && !activeDashboardProcess.killed) {
    try { activeDashboardProcess.kill(); } catch {}
  }
});

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

      child.on('error', (e) => {
        console.log(`  ⚠️ No se pudo lanzar verify-audio.js: ${e.message}`);
        notify(`⚠️ Auto-verify no arrancó: ${e.message}`, { title: 'verify-audio falló', priority: 'default', tags: 'warning' }).catch(() => {});
        resolve(false);
      });
      child.on('exit', (code) => {
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


async function withCdp(fn) {
  const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
  try {
    return await fn(browser);
  } finally {
    await browser.close().catch(() => {}); // CDP: solo desconecta, no cierra Chrome
  }
}

async function checkSunoLoginOnce() {
  return withCdp(async (browser) => {
    const context = browser.contexts()[0];
    const pages = context.pages();
    const page = pages.find((p) => p.url().includes('suno.com')) || pages[0];
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
    const context = browser.contexts()[0];
    const pages = context.pages();
    let page = pages.find((p) => p.url().includes('suno.com')) || pages[0];
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
    const context = browser.contexts()[0];
    let page = context.pages().find((p) => p.url().includes('cancioneterna.com'));
    const needNavigate = !page;
    if (!page) page = await context.newPage();
    await page.bringToFront();

    const result = await enterFlowAndEnsureAssignment(page, clickByText, { navigate: needNavigate });
    console.log(`  Flow listo (${result.assigned}).`);
  });
}

// ─── Helpers del modo --poll ──────────────────────────────────────────────────

// ¿Hay sesión de Suno viva en el puerto de Suno (9333)? Si la hay, NO es seguro
// arrancar el pipeline — run.js usa launchPersistentContext sobre el mismo perfil.
async function isSunoSessionLive() {
  if (!(await isPortUp(DEBUG_PORT))) return false;
  try {
    const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
    try {
      const ctx = browser.contexts()[0];
      const sunoPage = ctx.pages().find((p) => p.url().includes('suno.com'));
      if (!sunoPage) return false;
      return await isLoggedIn(sunoPage);
    } finally {
      await browser.close().catch(() => {});
    }
  } catch {
    return false;
  }
}

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

// Mata el Chrome del poller filtrando por su puerto — nunca por imagen (mataría
// el Chrome personal de Gabo). Usa PowerShell/CIM para filtrar por línea de cmd.
function closePollerChrome() {
  return new Promise((resolve) => {
    const cmd =
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*--remote-debugging-port=${POLL_PORT}*' } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
    const child = spawn('powershell', ['-NoProfile', '-Command', cmd], { stdio: 'ignore' });
    child.on('exit', () => resolve());
    child.on('error', () => resolve());
  });
}

// Un ciclo de poll: conecta al Chrome del poller, intenta asegurar asignación.
// Devuelve { found: true, title } si agarró una canción, { found: false } si la cola está vacía.
async function pollOnce(log) {
  const browser = await chromium.connectOverCDP(`http://localhost:${POLL_PORT}`);
  try {
    const ctx = browser.contexts()[0];
    let page = ctx.pages().find((p) => p.url().includes('cancioneterna.com'));
    const needNavigate = !page;
    if (!page) page = await ctx.newPage();
    await page.bringToFront();

    if (page.url().includes('/sign-in')) {
      log('⚠️ El Flow pide login. Iniciá sesión en la ventana del poller y va a seguir solo.');
      return { found: false };
    }

    try {
      const result = await enterFlowAndEnsureAssignment(page, clickByText, { navigate: needNavigate });
      if (result.entered !== true) return { found: false };
      let title = null;
      try { title = (await page.locator('#title').inputValue()).trim() || null; } catch {}
      return { found: true, title };
    } catch {
      // enterFlowAndEnsureAssignment tira si no hay #lyrics NI botón Assign utilizable.
      // En sequía lo normal es que Assign no traiga nada: cola vacía, no error fatal.
      return { found: false };
    }
  } finally {
    await browser.close().catch(() => {}); // CDP: solo desconecta
  }
}

// ─── Extracción de tiempo desde "Recent completions" ─────────────────────────

// Parsea "26 min session", "1h 5min session", "26min", etc.
// Devuelve { timeHHMM, totalTimeDecimal } o null si el formato no se reconoce.
function parseSessionTime(text) {
  if (!text) return null;
  const hourMin = text.match(/(\d+)\s*h\s*(\d+)\s*min/i);
  if (hourMin) {
    const h = parseInt(hourMin[1], 10);
    const m = parseInt(hourMin[2], 10);
    const totalMin = h * 60 + m;
    return {
      timeHHMM: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
      totalTimeDecimal: Math.round((totalMin / 60) * 100) / 100,
    };
  }
  const minOnly = text.match(/(\d+)\s*min/i);
  if (minOnly) {
    const totalMin = parseInt(minOnly[1], 10);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return {
      timeHHMM: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
      totalTimeDecimal: Math.round((totalMin / 60) * 100) / 100,
    };
  }
  return null;
}

// Conecta al Chrome del puerto de debug, navega a /artists/flow/create y extrae
// la primera card de "Recent completions": título, texto de sesión, time y screenshot.
// Lanza si no puede conectar, si el DOM no tiene la sección, si el título no
// coincide con expectedTitulo (cuando se pasa), o si el tiempo no se puede parsear.
// El screenshot falla sin lanzar (error logueado, screenshotPath queda null).
async function readRecentCompletion(expectedTitulo) {
  if (!(await isPortUp(DEBUG_PORT))) {
    throw new Error(`Chrome no está en el puerto ${DEBUG_PORT}`);
  }

  return withCdp(async (browser) => {
    const context = browser.contexts()[0];

    let page = context.pages().find((p) => p.url().includes('cancioneterna.com'));
    const openedNew = !page;
    if (!page) page = await context.newPage();

    // Navegar / refrescar a /create (la vista que muestra "Recent completions")
    if (!page.url().includes('/artists/flow/create')) {
      await page.goto(FLOW_CREATE_URL, { waitUntil: 'domcontentloaded' });
    } else {
      await page.reload({ waitUntil: 'domcontentloaded' });
    }
    await page.waitForSelector('h3:has-text("Recent completions")', { timeout: 15000 });
    // Optimización de ejecución AGY: Asegura que React renderizó las cards de completados antes de evaluate
    await page.waitForSelector('.rounded-xl.border.border-slate-100', { timeout: 10000 });
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

      const firstCard = panel.querySelector('.rounded-xl.border.border-slate-100');
      if (!firstCard) return { error: 'first card not found inside panel' };

      const titleEl = firstCard.querySelector('.font-medium.text-slate-900');
      const metaDiv = firstCard.querySelector('.text-xs.text-slate-500');
      const spans = metaDiv ? Array.from(metaDiv.querySelectorAll('span')) : [];
      const sessionSpan = spans.find((s) => /\d+\s*(h\s*\d*\s*min|min)/i.test(s.textContent));

      // Índice global para usarlo como nth() en Playwright
      const allCards = Array.from(document.querySelectorAll('.rounded-xl.border.border-slate-100'));
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

    // Verificar que el título coincide con el state.json actual
    const normalize = (s) =>
      s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

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

      const cardLocator = page.locator('.rounded-xl.border.border-slate-100').nth(cardData.cardIndex);
      await cardLocator.scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);
      await page.mouse.move(0, 0);
      await page.waitForTimeout(50);

      const cardHandle = await cardLocator.elementHandle();
      const rect = await cardHandle.evaluate(el => {
        const origStyle = el.getAttribute('style') || '';
        el.style.position = 'fixed';
        el.style.top = '0';
        el.style.left = '0';
        el.style.zIndex = '999999';
        el.style.margin = '0';
        return { width: el.offsetWidth, height: el.offsetHeight, origStyle };
      });

      await page.waitForTimeout(200);

      // Timeout corto (5s) por si la ventana está minimizada y Chrome suspende el render
      const imgBuffer = await page.screenshot({
        animations: 'disabled',
        timeout: 5000,
        clip: { x: 0, y: 0, width: rect.width, height: rect.height }
      });

      await cardHandle.evaluate((el, orig) => el.setAttribute('style', orig), rect.origStyle);

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

      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      console.log(`  Screenshot: ${screenshotPath} (${w}×${h}px)`);
    } catch (e) {
      console.log(`  ⚠️ Screenshot fallido (no es crítico): ${e.message}`);
    }

    if (openedNew) await page.close().catch(() => {});

    return {
      title: cardData.title,
      sessionText: cardData.sessionText,
      screenshotPath,
      ...parsed,
    };
  });
}

// ─── MODO --done: cierre del flujo ────────────────────────────────────────────
async function runDone() {
  const { logSongToSheet } = require('./lib/sheets-core');

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
    if (screenshotPath) {
      await tryDriveScreenshot(screenshotPath, result.row, result.tabName).catch(() => {});
    }

    const pending = ['Remarks', 'Flow Screenshot'];
    if (!timeHHMM) pending.unshift('Total Time', 'Time');
    if (screenshotPath) {
      console.log(`📸 Screenshot local: ${screenshotPath}`);
    }
    console.log(`⏱️  Te queda a mano en la hoja: ${pending.join(', ')}.`);

    // ── Pieza 9: remark draft (solo muestra, no escribe) ────────────────────
    const remarkDraft = buildRemarkDraft();
    console.log('\n📝 Borrador de Remarks (no se escribe solo — copialo si querés usarlo):');
    console.log(`   "${remarkDraft}"`);

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

// Intenta subir el screenshot a Google Drive y poner =IMAGE(url) en col H.
// Si el service account no tiene Drive scope, falla silenciosamente.
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
    const sheets = google.sheets({ version: 'v4', auth });
    const { SPREADSHEET_ID } = require('./lib/sheets-core');

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
  } catch (e) {
    console.log(`  ⚠️ Upload fallido (${e.message.substring(0, 80)}). Pega el screenshot manualmente en col H.`);
  }
}

// Pregunta en la misma sesión de terminal si ya se completó el Submit to QA.
// Retorna true si el usuario confirma con "s". En entornos no-interactivos (stdin
// no es TTY) no bloquea — informa que --done sigue disponible como fallback.
async function askDoneQuestion() {
  if (!process.stdin.isTTY) {
    console.log('\n(stdin no es terminal interactiva — no se puede pedir confirmación en línea.)');
    console.log('Cuando termines, registrá con: node start-flow.js --done');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('\n¿Ya hiciste Submit to QA? (s/n): ', (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 's');
    });
  });
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
  const skipSunoFill = resumeStage === state.STAGES.SUNO_FILLED || resumeStage === state.STAGES.FLOW_FILLED;
  // Solo saltear el llenado del Flow si la canción ya está COMPLETED (subida
  // + registrada). Para cualquier otra etapa, siempre re-abrir y asegurar que
  // el Flow esté lleno para revisión manual — pero no tiene sentido
  // re-rellenar título/letra/notas de una canción que ya se cerró del todo.
  const skipFlowFill = resumeStage === state.STAGES.COMPLETED;

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
    const providerArg = process.argv.find((a) => a.startsWith('--provider='));
    const providerFlag = providerArg ? ` ${providerArg}` : '';
    await runScript(`run.js${providerFlag}`);
  }

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
  let verifyOk = false;
  let verifyPromise = null; // corre en paralelo con el Paso 4; se espera después
  if (skipSunoFill) {
    // En resume no sabemos si el crash fue antes o después del click en Create.
    // Re-clickearlo podría gastar créditos por duplicado, así que solo se buscan
    // los MP3 en disco (ventana amplia de 180 min por si pasó un rato).
    console.log('\n=== Paso 3b/4: --resume — buscando MP3s ya descargados (sin re-clickear Create) ===');
    try {
      const { findSunoMp3s } = require('./lib/audio-match');
      const { versionA, versionB } = findSunoMp3s(state.read()?.titulo || null, { recencyMinutes: 180 });
      mp3sDescargados = true;
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
    console.log('\n=== Paso 3b/4: Create + generación + descarga (suno-create-dl.js) ===');
    console.log('  (Pasá --no-auto-create para saltar este paso y hacer Create a mano)\n');
    try {
      const { createAndDownload } = require('./lib/suno-create-dl');
      const { versionA, versionB } = await createAndDownload();
      mp3sDescargados = true;
      await notify(
        `MP3s listos: "${state.read()?.titulo || 'canción'}".\nVersiones A y B en Downloads/suno/.\nCorré: node verify-audio.js`,
        { title: 'Suno: generación completa', priority: 'high', tags: 'musical_note' }
      );
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
      console.log(`\n  ⚠️ Create/descarga automático falló: ${e.message}`);
      console.log('  Continuando con el resto del pipeline. Create manual disponible con:');
      console.log('    node suno-create.js   (clickea Create)');
      console.log('    node verify-audio.js  (analiza después de descargar)');
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

  // ── Paso 5: Recomendación + Upload automático ──────────────────────────────
  // verifyOk + chequeo de título: verify-report.json puede quedar con datos de
  // una canción anterior si el auto-verify de ESTA corrida falló antes de
  // reescribirlo, o si --no-auto-verify se usó y el archivo quedó viejo. Nunca
  // confiar en el archivo solo porque existe — ver el bug de "canción
  // equivocada" documentado en lib/pipeline-state.js.
  const REPORT_PATH = path.join(__dirname, 'verify-report.json');
  const currentTitulo = state.read()?.titulo || null;
  if (mp3sDescargados && verifyOk && fs.existsSync(REPORT_PATH)) {
    try {
      const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf-8'));

      if (currentTitulo && report.titulo && report.titulo !== currentTitulo) {
        console.log(
          `\n⚠️ verify-report.json es de otra canción ("${report.titulo}") — no coincide con la actual ("${currentTitulo}"). Ignorando el reporte.`
        );
        throw new Error('verify-report.json desactualizado');
      }

      const rec = report.recommendation;

      console.log('\n══════════════════════════════════════════════════════');
      console.log(`📊 RECOMENDACIÓN: Versión ${rec.recommended}`);
      console.log(`   Razón: ${rec.reason}`);
      if (report.reportA) console.log(`   A: ${report.reportA.durationFormatted} — letra ${Math.round((report.reportA.levenshteinScore || 0) * 100)}%${report.reportA.clippingFlag ? ' — ⚠️ clipping' : ''}${report.reportA.abruptCutoff ? ' — ⚠️ corte abrupto' : ''}`);
      if (report.reportB) console.log(`   B: ${report.reportB.durationFormatted} — letra ${Math.round((report.reportB.levenshteinScore || 0) * 100)}%${report.reportB.clippingFlag ? ' — ⚠️ clipping' : ''}${report.reportB.abruptCutoff ? ' — ⚠️ corte abrupto' : ''}`);
      if (rec.scoreB !== null) console.log(`   Puntajes: A=${rec.scoreA}, B=${rec.scoreB}`);
      console.log('══════════════════════════════════════════════════════');
      console.log('\n👉 Escuchá ambas versiones antes de decidir. La recomendación es ORIENTATIVA.');

      console.log('\n👉 Iniciando el QA Dashboard de lectura (puerto 3000)...');
      const dashboardProcess = spawn('node', ['qa-dashboard.js'], { stdio: 'inherit' });
      activeDashboardProcess = dashboardProcess;

      // Abrir el navegador automáticamente apuntando al dashboard de audio
      setTimeout(() => {
        spawn('powershell', ['-NoProfile', '-Command', 'Start-Process http://localhost:3000'], { stdio: 'ignore' }).unref();
      }, 1500);

      let versionChoice;
      try {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        versionChoice = await new Promise((resolve) => {
          rl.question(`\n¿Subir Versión ${rec.recommended} al Flow? (s = sí, n = no subir, A/B = subir la otra): `, (answer) => {
            rl.close();
            resolve(answer.trim().toUpperCase());
          });
        });
      } finally {
        // Pase lo que pase (excepción, respuesta normal), nunca dejar el
        // dashboard corriendo en el puerto 3000.
        dashboardProcess.kill();
        activeDashboardProcess = null;
      }

      let versionToUpload = null;
      if (versionChoice === 'S' || versionChoice === 'SI' || versionChoice === 'SÍ' || versionChoice === 'Y') {
        versionToUpload = rec.recommended;
      } else if (versionChoice === 'A' || versionChoice === 'B') {
        versionToUpload = versionChoice;
      }

      if (versionToUpload) {
        console.log(`\n=== Subiendo Versión ${versionToUpload} al Flow (upload-to-flow.js) ===\n`);
        await runScript(`upload-to-flow.js --version ${versionToUpload}`);
        state.write({ stage: state.STAGES.FLOW_FILLED });
        console.log(`\n✅ Versión ${versionToUpload} subida al Flow exitosamente.`);
      } else {
        console.log('\n(No se subió ninguna versión. Podés hacerlo manualmente con: node upload-to-flow.js --version A|B)');
      }
    } catch (e) {
      console.log(`\n⚠️ No se pudo leer verify-report.json: ${e.message}`);
      console.log('   Subí el MP3 manualmente con: node upload-to-flow.js --version A|B');
    }
  } else if (mp3sDescargados) {
    console.log(
      '\n✅ Flujo completo. MP3s descargados en Downloads/suno/.\n' +
        '   Revisá: suno-verify-overview.png, suno-verify-lyrics-expanded.png y flow-submit-verify.png.\n' +
        '\n   Pasos manuales:\n' +
        '     1. node verify-audio.js       → analiza las 2 versiones\n' +
        '     2. Escuchá y elegí la versión\n' +
        '     3. node upload-to-flow.js --version A|B  → sube el MP3 al Flow\n'
    );
  } else {
    console.log(
      '\n✅ Flujo completo hasta el checkpoint visual.\n' +
        '   Revisá: suno-verify-overview.png, suno-verify-lyrics-expanded.png y flow-submit-verify.png.\n' +
        '\n   Pasos manuales:\n' +
        '     1. Clickeá Create en Suno (o: node suno-create.js)\n' +
        '     2. Descargá los 2 MP3 a Downloads/suno/\n' +
        '     3. node verify-audio.js     → analiza duración y letra\n' +
        '     4. node upload-to-flow.js --version A|B  → sube el MP3 elegido\n'
    );
  }

  // ── Paso final: Submit to QA manual + registro ─────────────────────────────
  console.log('🛑 Hacé Submit to QA manualmente en el Flow.');
  const confirmed = await askDoneQuestion();
  if (confirmed) {
    await runDone();
  } else {
    console.log('\n(No se registró en la hoja. Podés hacerlo después con: node start-flow.js --done)');
  }
}

// ─── MODO --poll: vigía de cola ───────────────────────────────────────────────
async function runPoll(rawArgs) {
  function ts() { return new Date().toLocaleTimeString('es', { hour12: false }); }
  function log(msg) { console.log(`[${ts()}] ${msg}`); }

  const pollIdx = rawArgs.indexOf('--poll');
  const afterPoll = rawArgs[pollIdx + 1];
  // Si el siguiente arg empieza con '-' es otra flag, no el intervalo
  const intervalArg = (afterPoll && !afterPoll.startsWith('-')) ? afterPoll : '3';
  const isSeconds = intervalArg.toLowerCase().endsWith('s');
  const intervalMs = isSeconds
    ? parseFloat(intervalArg) * 1000
    : parseFloat(intervalArg) * 60 * 1000;
  const intervalLabel = isSeconds ? `${parseFloat(intervalArg)}s` : `${parseFloat(intervalArg)} min`;

  log(`Vigía de cola iniciado. Revisando cada ${intervalLabel}. (Ctrl+C para detener.)`);
  log(`Log de esta corrida: ${RUN_LOG_PATH}`);

  // Chequeo de seguridad: no arrancar si hay Suno vivo en el puerto de Suno.
  if (await isSunoSessionLive()) {
    log('⚠️ Hay una sesión de Suno abierta (puerto 9333). Cerrá esa ventana antes de usar el poller');
    log('   para que no se pisen los perfiles de Chrome. Saliendo sin tocar nada.');
    process.exit(1);
  }

  // Asegurar el Chrome del poller arriba en el puerto 9334.
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
      await notify(body, { title: 'Cancion Eterna', priority: 'high', tags: 'musical_note' });

      // Segundo chequeo de Suno: puede haberse abierto mientras polleábamos.
      if (await isSunoSessionLive()) {
        log('⚠️ Hay una sesión de Suno abierta (puerto 9333). No es seguro arrancar el pipeline.');
        log('   Cerrá esa ventana y corrí manualmente: node start-flow.js');
        process.exit(1);
      }

      log('Cerrando la ventana del poller para liberar el perfil de Chrome...');
      await closePollerChrome();

      // Esperar señal concreta: puerto caído = proceso muerto = perfil desbloqueado.
      // Nunca un sleep fijo — ver LESSONS.md.
      for (let i = 0; i < 20 && (await isPortUp(POLL_PORT)); i++) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (await isPortUp(POLL_PORT)) {
        log('❌ El Chrome del poller no se cerró a tiempo. Cerrá Chrome manualmente y corrí: node start-flow.js');
        process.exit(1);
      }

      log('Chrome cerrado. Arrancando el pipeline...\n');
      await runFlow();
      return; // runFlow() ya loguea el resultado final
    }

    log(`Aún no hay canciones. Próximo intento en ${intervalLabel}.`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ─── Entrada ──────────────────────────────────────────────────────────────────
(async () => {
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

  if (isDone) {
    await runDone();
  } else if (isPoll) {
    await runPoll(rawArgs);
  } else {
    try {
      await runFlow({ resume: isResume });
    } catch (err) {
      if (err.noSong) {
        console.log('\nNo hay canciones en cola. Entrando en modo poll automático (intervalo: 59s)...\n');
        await runPoll(['--poll', '59s']);
      } else {
        throw err;
      }
    }
  }
})().catch((err) => {
  console.error('Orquestación falló:', err);
  process.exit(1);
});
