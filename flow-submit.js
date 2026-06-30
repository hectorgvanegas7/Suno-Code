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

const SONG_PATH = path.join(__dirname, 'song.txt');
const DEBUG_PORT = 9333;
const SCREENSHOT_PATH = path.join(__dirname, 'flow-submit-verify.png');

function parseSongFile(content) {
  const titulo = (content.match(/\*\*Título:\*\*\s*(.+)/i) || [])[1]?.trim();
  const verseIndex = content.search(/\[Verse 1\]/i);
  const advertenciasIndex = content.search(/\*\*Advertencias:\*\*/i);
  const notesIndex = content.search(/NOTES:/i);
  const lyricsEndIndex = [advertenciasIndex, notesIndex].filter((i) => i !== -1).sort((a, b) => a - b)[0];
  const lyrics = verseIndex !== -1
    ? content.slice(verseIndex, lyricsEndIndex === undefined ? undefined : lyricsEndIndex).trim()
    : null;
  const notesMatch = content.match(/NOTES:\s*([\s\S]+)/i);
  const notes = notesMatch ? notesMatch[1].trim() : null;
  return { titulo, lyrics, notes };
}

// Strips "Song ID: xxxx" when building the text for the Flow's Notes field.
// The portal already has its own Song ID field — repeating it in Notes is redundant.
// song.txt keeps the full NOTES line (with Song ID) for internal tracking.
function buildFlowNotes(rawNotes) {
  return rawNotes.replace(/\s*Song ID:\s*\S+/i, '').trim();
}

async function connectToFlowTab(debugPort = DEBUG_PORT) {
  const browser = await chromium.connectOverCDP(`http://localhost:${debugPort}`);
  const context = browser.contexts()[0];
  const pages = context.pages();
  const page = pages.find((p) => p.url().includes('cancioneterna.com'));
  if (!page) {
    const openUrls = pages.map((p) => p.url()).join(', ') || '(ninguna)';
    throw new Error(
      `No se encontró ninguna tab de cancioneterna.com en el Chrome del puerto ${debugPort}. Tabs abiertas: ${openUrls}`
    );
  }
  await page.bringToFront();
  return { browser, page };
}

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
  const songContent = fs.readFileSync(SONG_PATH, 'utf-8');
  const { titulo, lyrics, notes } = parseSongFile(songContent);
  if (!titulo || !lyrics || !notes) {
    throw new Error('No se pudo parsear título, letra o NOTES de song.txt — ¿archivo corrupto o truncado?');
  }
  const flowNotes = buildFlowNotes(notes);
  console.log('  Título:', titulo);
  console.log('  Lyrics length:', lyrics.length, 'chars');
  console.log('  Notes (para el Flow):', flowNotes);

  const { browser, page } = await connectToFlowTab();
  console.log('Conectado a:', page.url());
  await page.waitForLoadState('networkidle').catch(() => {});

  const titleLocator = page.locator('#title');
  const lyricsLocator = page.locator('#lyrics');
  if ((await titleLocator.count()) === 0 || (await lyricsLocator.count()) === 0) {
    throw new Error('No se encontraron #title / #lyrics en la página. ¿Hay una asignación activa cargada en el Flow?');
  }

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

  await page.waitForTimeout(300);
  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
  console.log(`\nScreenshot de verificación guardado en ${SCREENSHOT_PATH}`);
  console.log('Deteniéndose acá. Revisá el screenshot antes de subir el MP3 y hacer Submit to QA manualmente.');

  await browser.close().catch(() => {}); // CDP: solo desconecta, no cierra Chrome
})().catch((err) => {
  console.error('flow-submit.js falló:', err);
  process.exit(1);
});
