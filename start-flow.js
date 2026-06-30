// start-flow.js — Orquestador único del pipeline. Un solo comando:
//
//   node start-flow.js              -> flujo completo hasta el checkpoint visual
//                                      (genera letra, llena Suno, llena el Flow)
//                                      y se detiene para que Gabo escuche, elija
//                                      versión, descargue el MP3 y lo suba.
//
//   node start-flow.js --done       -> cierre: registra la canción en la hoja y
//                                      marca el estado como completado. Se corre
//                                      DESPUÉS de subir el MP3 al Flow.
//
//   node start-flow.js --poll [N]   -> vigía de cola: abre una ventana de Chrome
//                                      en el puerto 9334, y verifica cada N minutos
//                                      (default 3) si cayó una canción. Cuando
//                                      encuentra una, cierra esa ventana y arranca
//                                      el flujo completo automáticamente.
//                                      Acepta segundos con sufijo "s" (ej: 30s, 59s).
//
// Por qué dos modos de producción y no uno solo: entre llenar el Flow y registrar
// en la hoja hay un hueco humano OBLIGATORIO (escuchar las 2 versiones de Suno ~8 min,
// elegir, descargar MP3, subirlo + Submit to QA). Automatizar ese juicio bajaría la
// calidad — y un REDO por error del artista no es elegible para pago.
//
// Pasos del modo normal (y del poller al encontrar canción):
//   0. Preflight (API key, credenciales, deps).
//   1. run.js          — genera letra, guarda song.txt, escribe state.json.
//   2. Asegura Chrome en el puerto de debug + sesión de Suno logueada.
//   3. suno-fill.js    — llena el formulario de Suno + screenshots de verify.
//   4. flow-submit.js  — abre/reusa la tab del Flow (vía helper compartido que
//                        SIEMPRE asegura asignación activa) y llena título/letra/notas.
//
// run.js cierra su propio Chrome al terminar (perfil compartido con Suno — ver
// LESSONS.md "CDP lifecycle pattern"), así que para el Paso 4 reusamos el Chrome
// del puerto de debug (el de Suno) en vez de lanzar uno nuevo que pisaría su sesión.
//
// El modo --poll usa el puerto 9334 (distinto del de Suno, 9333). Antes de lanzar
// el flujo, cierra su Chrome y espera a que el puerto caiga — señal concreta de que
// el proceso murió y el perfil quedó libre. Nunca un sleep fijo. Ver LESSONS.md
// "Perfil compartido: poller cerró Chrome, pero run.js lo encontró todavía abierto".

const { spawn } = require('child_process');
const readline = require('readline');
const { chromium } = require('playwright');
const { isLoggedIn, clickByText } = require('./lib/playwright-helpers');
const { enterFlowAndEnsureAssignment, FLOW_URL } = require('./lib/flow-helpers');
const { runPreflight } = require('./lib/preflight');
const state = require('./lib/pipeline-state');

const DEBUG_PORT = 9333;   // Chrome de Suno (ya corriendo para suno-fill y flow-submit)
const POLL_PORT  = 9334;   // Chrome propio del modo --poll (se abre y cierra dentro del modo)
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER_DATA_DIR = 'C:\\Users\\hecto\\AppData\\Local\\ChromeAutomationProfile';
const PROFILE_DIRECTORY = 'Profile 1';
const LOGIN_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

function runScript(scriptName) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptName], { cwd: __dirname, stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else {
        const err = new Error(`${scriptName} terminó con código ${code}`);
        if (code === 2) err.noSong = true; // código 2 = cola vacía (ver flow-helpers.js)
        reject(err);
      }
    });
    child.on('error', reject);
  });
}

async function isPortUp(port) {
  try {
    const res = await fetch(`http://localhost:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
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

// ─── MODO --done: cierre del flujo ────────────────────────────────────────────
async function runDone() {
  const { logSongToSheet } = require('./lib/sheets-core');

  console.log('=== Cierre (--done): registrando en la hoja ===\n');

  // Validar que la canción en song.txt es la misma que generamos en esta sesión.
  const current = state.read();
  if (current) {
    console.log(`Canción activa según state.json: "${current.titulo}" (${current.songId}), etapa: ${current.stage}`);
  } else {
    console.log('⚠️ No hay state.json. Registrando lo que haya en song.txt de todas formas.');
  }

  const result = await logSongToSheet();

  if (result.written) {
    // Validar coherencia con el estado, sólo para avisar (no abortar).
    if (current && current.songId !== result.songId) {
      console.log(
        `\n⚠️ OJO: registré "${result.songId}" pero state.json tenía "${current.songId}". ` +
          'Verificá que registraste la canción correcta.'
      );
    }
    state.write({ songId: result.songId, titulo: result.titulo, stage: state.STAGES.COMPLETED });
    console.log('\n✅ Canción registrada y marcada como completada.');
    console.log('⏱️  Te queda a mano en la hoja: Total Time, Time, Remarks y Flow Screenshot.');
  } else if (result.reason === 'duplicate') {
    console.log('\n(No se registró de nuevo — ya estaba en la hoja.)');
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
async function runFlow() {
  console.log('=== Paso 0/4: preflight ===');
  const pre = runPreflight();
  if (!pre.ok) {
    throw new Error('Preflight falló. Resolvé lo de arriba y volvé a correr.');
  }

  console.log('\n=== Paso 1/4: generando letra (run.js) ===\n');
  await runScript('run.js');

  console.log('\n=== Paso 2/4: verificando sesión de Suno ===');
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

  if (await checkSunoLoginOnce()) {
    console.log('Sesión de Suno confirmada (sin "Sign in", botón Create presente).');
  } else {
    console.log('No hay sesión activa en Suno. Iniciá sesión manualmente en la ventana de Chrome (esperando hasta 5 minutos)...');
    await waitUntilSunoLoggedIn();
    console.log('Login detectado.');
  }

  console.log('\n=== Paso 3/4: llenando formulario de Suno (suno-fill.js) ===\n');
  await runScript('suno-fill.js');
  state.write({ stage: state.STAGES.SUNO_FILLED });

  console.log('\n=== Paso 4/4: llenando título/letra/notas en el Flow (flow-submit.js) ===');
  await openFlowTabAndEnsureAssignment();
  await runScript('flow-submit.js');
  state.write({ stage: state.STAGES.FLOW_FILLED });

  console.log(
    '\n✅ Flujo completo hasta el checkpoint visual.\n' +
      '   Revisá: suno-verify-overview.png, suno-verify-lyrics-expanded.png y flow-submit-verify.png.\n' +
      '\n   Pasos manuales:\n' +
      '     1. Clickeá Create en Suno\n' +
      '     2. Escuchá las 2 versiones, elegí y descargá el MP3\n' +
      '     3. Subilo al Flow y hacé Submit to QA\n' +
      '\n   Cuando termines los pasos de arriba, volvé acá y respondé.'
  );
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

      try {
        const body = pollResult.title
          ? `Canción asignada: "${pollResult.title}"`
          : 'Canción asignada y lista para procesar.';
        await fetch('https://ntfy.sh/cancioneterna-gabo-2026', {
          method: 'POST',
          headers: { Title: 'Cancion Eterna', Priority: 'high', Tags: 'musical_note' },
          body,
        });
      } catch {}

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

  if (isDone) {
    await runDone();
  } else if (isPoll) {
    await runPoll(rawArgs);
  } else {
    try {
      await runFlow();
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
