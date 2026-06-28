// start-flow.js — Orquestador único del pipeline. Un solo comando:
//
//   node start-flow.js          -> corre el flujo completo hasta el checkpoint
//                                   visual (genera letra, llena Suno, llena el
//                                   Flow) y se detiene para que Gabo escuche,
//                                   elija versión, descargue el MP3 y lo suba.
//
//   node start-flow.js --done   -> cierre: registra la canción en la hoja y
//                                   marca el estado como completado. Se corre
//                                   DESPUÉS de subir el MP3 al Flow.
//
// Por qué dos modos y no uno solo: entre llenar el Flow y registrar en la hoja
// hay un hueco humano OBLIGATORIO (escuchar las 2 versiones de Suno ~8 min,
// elegir, descargar MP3, subirlo + Submit to QA). Automatizar ese juicio
// bajaría la calidad — y un REDO por error del artista no es elegible para pago.
//
// Pasos del modo normal:
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

const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { isLoggedIn, clickByText } = require('./lib/playwright-helpers');
const { enterFlowAndEnsureAssignment } = require('./lib/flow-helpers');
const { runPreflight } = require('./lib/preflight');
const state = require('./lib/pipeline-state');

const DEBUG_PORT = 9333;
const LOGIN_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

function runScript(scriptName) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptName], { cwd: __dirname, stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${scriptName} terminó con código ${code}`));
    });
    child.on('error', reject);
  });
}

async function isChromeDebugPortUp() {
  try {
    const res = await fetch(`http://localhost:${DEBUG_PORT}/json/version`);
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
// helper compartido para garantizar que haya una asignación activa (#lyrics)
// — clickeando "Enter Flow" y "Assign Most Urgent Song" según haga falta.
// Esto es lo que arregla el viejo bug del Paso 4/4: antes start-flow tenía una
// versión incompleta de esta lógica que nunca clickeaba "Assign Most Urgent Song".
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
  if (await isChromeDebugPortUp()) {
    console.log('Chrome ya está corriendo en el puerto de debug.');
  } else {
    console.log('Chrome no está en el puerto de debug. Lanzando suno-open-for-login.js...');
    await runScript('suno-open-for-login.js');
    for (let i = 0; i < 20 && !(await isChromeDebugPortUp()); i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!(await isChromeDebugPortUp())) {
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
      '   Ahora a mano: tocá Create en Suno, escuchá las 2 versiones, elegí, descargá el MP3,\n' +
      '   subilo al Flow y hacé Submit to QA.\n' +
      '   Cuando termines, cerrá la canción con:  node start-flow.js --done'
  );
}

// ─── Entrada ──────────────────────────────────────────────────────────────────
(async () => {
  const isDone = process.argv.includes('--done');
  if (isDone) {
    await runDone();
  } else {
    await runFlow();
  }
})().catch((err) => {
  console.error('Orquestación falló:', err);
  process.exit(1);
});
