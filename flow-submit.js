// Llena el formulario del Artist Flow (cancioneterna.com) con título, letra
// y notas leídos de song.txt. Conecta por CDP al Chrome ya abierto en el
// puerto 9333 (mismo método que suno-fill.js / lib/playwright-helpers.js).
//
// NUNCA clickea "Submit to QA" — eso lo hace Hector manualmente, siempre.
// NUNCA cierra Chrome. El upload del MP3 es manual.
//
// #title y #lyrics son selectors confirmados (run.js los usa para leer el
// estado REDO). El campo de notas no tiene selector confirmado todavía, así
// que se busca por varias estrategias y se loguea qué se encontró antes de
// escribir — revisar el screenshot final siempre, igual que con Suno.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { pauseForHumanInteraction, isPortUp, connectToFlowTab } = require('./lib/playwright-helpers');
const state = require('./lib/pipeline-state');
const { parseSongFile, buildRedoAwareNotes } = require('./lib/song-file');

const SONG_PATH = path.join(__dirname, 'song.txt');
const DEBUG_PORT = 9333;

// Windows (libuv): terminar el proceso con una conexión CDP todavía abierta
// puede crashear con "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"
// si el socket se cierra en el mismo tick que process.exit() — verificado
// empíricamente en run.js (ver LESSONS.md). Este script nunca hace
// browser.close() (deja la pestaña abierta a propósito), pero la conexión
// CDP igual queda viva hasta que el proceso termina, así que el mismo riesgo
// aplica. El delay le da tiempo al event loop a limpiar antes de forzar la salida.
function exitAfterDelay(code) {
  setTimeout(() => process.exit(code), 250);
}
const SCREENSHOT_PATH = path.join(__dirname, 'flow-submit-verify.png');

// Pone el valor en un <input>/<textarea> controlado por React usando el
// native setter del prototipo (evita que React ignore .value = x directo),
// y dispara los eventos que React escucha. Si después de eso el valor leído
// no coincide, cae a clipboard + Ctrl+V como segundo intento.
async function fillReactField(page, locator, value, label) {
  const handle = await locator.elementHandle();
  if (!handle) throw new Error(`[${label}] no se pudo obtener el elemento.`);

  await handle.evaluate((el, val) => {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    nativeSetter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await page.waitForTimeout(200);

  let current = await locator.inputValue();
  if (current.trim() !== value.trim()) {
    console.log(`  [${label}] nativeSetter no tomó el valor, probando clipboard paste...`);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    await page.evaluate((val) => navigator.clipboard.writeText(val), value);
    await locator.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(300);
    current = await locator.inputValue();
  }

  if (current.trim() !== value.trim()) {
    console.warn(`  ⚠️ [${label}] el valor final no coincide con lo esperado. Revisar manualmente en el screenshot.`);
  } else {
    console.log(`  [${label}] OK (${current.length} chars)`);
  }
  return current;
}

// El campo de notas no tiene id confirmado todavía. Busca por label/aria-label/
// placeholder/name/id que contengan "note" (en inglés o español), entre los
// inputs/textareas visibles que no sean #title ni #lyrics.
async function findNotesField(page) {
  // Regla de LESSONS.md: cada sección dinámica necesita su PROPIA espera —
  // que #title/#lyrics ya existan no garantiza que el campo de notas (que
  // puede montarse async) esté en el DOM. Sin esto, el querySelectorAll
  // inmediato de abajo devolvía null y las notas quedaban sin escribir con
  // solo un warning. Timeout tolerado: si de verdad no existe, el flujo
  // sigue cayendo al mismo camino de "llenar a mano" de siempre.
  await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll('input, textarea')).some((el) => {
      if (el.id === 'title' || el.id === 'lyrics') return false;
      if (!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) return false;
      let label = el.closest('label')?.innerText || null;
      if (!label && el.id) {
        const lbl = document.querySelector(`label[for="${el.id}"]`);
        label = lbl ? lbl.innerText : null;
      }
      const haystack = [label, el.getAttribute('aria-label'), el.placeholder, el.name, el.id]
        .filter(Boolean).join(' ').toLowerCase();
      return /not[ae]/.test(haystack);
    });
  }, { timeout: 15000 }).catch(() => {});

  const candidates = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('input, textarea').forEach((el, idx) => {
      if (el.id === 'title' || el.id === 'lyrics') return;
      let label = el.closest('label')?.innerText || null;
      if (!label && el.id) {
        const lbl = document.querySelector(`label[for="${el.id}"]`);
        label = lbl ? lbl.innerText : null;
      }
      const haystack = [label, el.getAttribute('aria-label'), el.placeholder, el.name, el.id]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      out.push({
        idx,
        id: el.id,
        name: el.name,
        placeholder: el.placeholder,
        ariaLabel: el.getAttribute('aria-label'),
        label,
        matchesNotes: /not[ae]/.test(haystack),
        visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
      });
    });
    return out;
  });

  const visible = candidates.filter((c) => c.visible);
  const match = visible.find((c) => c.matchesNotes);

  if (!match) {
    console.log('  No se encontró un campo de notas por heurística. Campos visibles disponibles:');
    console.log(JSON.stringify(visible, null, 2));
    return null;
  }

  console.log('  Campo de notas detectado:', JSON.stringify(match));
  const allFields = page.locator('input, textarea');
  return allFields.nth(match.idx);
}

(async () => {
  console.log('Leyendo song.txt...');
  if (!fs.existsSync(SONG_PATH)) {
    throw new Error('No existe song.txt — corré primero node run.js (o node start-flow.js).');
  }
  const songContent = fs.readFileSync(SONG_PATH, 'utf-8');
  const hashCheck = state.checkSongTxtContent(songContent);
  if (!hashCheck.ok) {
    console.warn(`⚠️  ${hashCheck.reason}`);
  }
  const { titulo, lyrics, notes } = parseSongFile(songContent);
  if (!titulo || !lyrics || !notes) {
    throw new Error('No se pudo parsear título, letra o NOTES de song.txt — ¿archivo corrupto o truncado?');
  }
  // Nota estándar SIEMPRE presente ("<fecha>. Hector. PS0180. Letra + Suno.")
  // + "Redo Fix, corregido" agregado DEBAJO si es REDO — ver
  // buildRedoAwareNotes en lib/song-file.js. Solo se confía en state.json si
  // el título coincide con song.txt (nunca asumir que state es de esta
  // canción — ver lib/pipeline-state.js).
  const st = state.read();
  const isRedo = !!(st && st.isRedo && st.titulo === titulo);
  const flowNotes = buildRedoAwareNotes(notes, { isRedo });
  if (isRedo) {
    console.log('  REDO detectado (state.json) — se agrega "Redo Fix, corregido" debajo de la nota estándar.');
  }
  console.log('  Título:', titulo);
  console.log('  Lyrics length:', lyrics.length, 'chars');
  console.log('  Notes (para el Flow):', flowNotes);

  if (!(await isPortUp(DEBUG_PORT))) {
    throw new Error(`❌ Chrome no está escuchando en el puerto ${DEBUG_PORT}. ¿Olvidaste iniciarlo con la flag de debugging?`);
  }

  const { browser, page } = await connectToFlowTab(chromium, DEBUG_PORT);
  console.log('Conectado a:', page.url());

  try {
    try {
      await page.waitForSelector('#title', { timeout: 15000 });
      await page.waitForSelector('#lyrics', { timeout: 15000 });
    } catch {
      throw new Error('No se encontraron #title / #lyrics en la página. ¿Hay una asignación activa cargada en el Flow?');
    }
    const titleLocator = page.locator('#title');
    const lyricsLocator = page.locator('#lyrics');

    console.log('\nLlenando título...');
    await fillReactField(page, titleLocator, titulo, 'title');

    console.log('Llenando letra...');
    await fillReactField(page, lyricsLocator, lyrics, 'lyrics');

    console.log('Buscando campo de notas...');
    const notesLocator = await findNotesField(page);
    if (notesLocator) {
      console.log('Llenando notas...');
      // No pisar las notas/feedback que ya haya en el campo (de QC u otra persona):
      // las nuevas se agregan abajo, no reemplazan lo existente.
      const existingNotes = (await notesLocator.inputValue()).trim();
      const combinedNotes =
        existingNotes && !existingNotes.includes(flowNotes)
          ? `${existingNotes}\n\n${flowNotes}`
          : existingNotes || flowNotes;
      await fillReactField(page, notesLocator, combinedNotes, 'notes');
    } else {
      console.warn('  ⚠️ No se llenó el campo de notas — no se encontró con la heurística actual. Llenar a mano.');
    }
  } catch (err) {
    console.error('\n❌ Error interactuando con la interfaz del Artist Flow:', err.message);
    await pauseForHumanInteraction('La interfaz del Artist Flow cambió o no hay una asignación activa. Por favor, copia y pega el Título, Letra y Notas manualmente en la página web.');
  }

  await page.waitForTimeout(300);
  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
  console.log(`\nScreenshot de verificación guardado en ${SCREENSHOT_PATH}`);
  console.log('Deteniéndose acá. Revisá el screenshot antes de subir el MP3 y hacer Submit to QA manualmente.');

  console.log('Dejando la pestaña del Flow abierta para tu revisión manual.');
  await browser.close().catch(() => {});
  exitAfterDelay(0);
})().catch((err) => {
  console.error('flow-submit.js falló:', err);
  exitAfterDelay(1);
});
