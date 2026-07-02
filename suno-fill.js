const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { safeClick, setSliderValue, expandIfCollapsed, withReloadRetry, connectToSunoTab, pauseForHumanInteraction, isPortUp } = require('./lib/playwright-helpers');
const { LYRICS_TEXTAREA, TITLE_INPUT, STYLE_TEXTAREA, MORE_OPTIONS_TOGGLE_TEXT, WEIRDNESS_SLIDER_LABEL, STYLE_INFLUENCE_SLIDER_LABEL, EXPAND_LYRICS_BOX_LABEL } = require('./lib/suno-selectors');

const SONG_PATH = path.join(__dirname, 'song.txt');

function parseSongFile(content) {
  const titulo = (content.match(/\*\*Título:\*\*\s*(.+)/i) || [])[1]?.trim();
  const voz = (content.match(/\*\*Voz:\*\*\s*(.+)/i) || [])[1]?.trim();
  const estilo = (content.match(/\*\*Estilo Suno:\*\*\s*(.+)/i) || [])[1]?.trim();
  const verseIndex = content.search(/\[Verse 1\]/i);
  const advertenciasIndex = content.search(/\*\*Advertencias:\*\*/i);
  const notesIndex = content.search(/NOTES:/i);
  const endIndex = [advertenciasIndex, notesIndex].filter((i) => i !== -1).sort((a, b) => a - b)[0];
  const lyrics = verseIndex !== -1
    ? content.slice(verseIndex, endIndex === undefined ? undefined : endIndex).trim()
    : null;
  return { titulo, voz, estilo, lyrics };
}

// Fills every field of Suno's Advanced create form. All text-based selectors
// live in here so that withReloadRetry can re-run this entire function from
// scratch if any selector times out due to Suno rendering raw i18n keys.
async function fillSunoForm(page, titulo, voz, estilo, lyrics, genderTarget) {
  // Reset form to a clean baseline
  const clearBtn = page.getByLabel('Clear all form inputs');
  if ((await clearBtn.count()) > 0) {
    await clearBtn.click().catch(() => {});
    await page.waitForTimeout(500);
    const confirmBtn = page.getByRole('button', { name: 'Confirm', exact: true });
    if ((await confirmBtn.count()) > 0) {
      await confirmBtn.click().catch(() => {});
    }
    await page.waitForTimeout(1000);
  }

  // Ensure Advanced tab active
  const advancedTab = page.getByRole('tab', { name: 'Advanced' });
  if ((await advancedTab.count()) > 0) {
    const cls = (await advancedTab.getAttribute('class')) || '';
    if (!cls.includes('active')) await advancedTab.click();
  }
  await page.waitForTimeout(500);

  // Ensure "Write" lyrics sub-mode
  const writeTab = page.getByRole('radio', { name: 'Write' });
  if ((await writeTab.count()) > 0) await writeTab.click().catch(() => {});
  await page.waitForTimeout(300);

  // Fill Lyrics
  const lyricsBox = page.locator(LYRICS_TEXTAREA).first();
  await lyricsBox.click({ force: true });
  // Usar teclado directamente si fill falla por ser un editor Lexical (contenteditable complejo)
  try {
    await lyricsBox.fill(lyrics, { force: true });
  } catch (e) {
    // Fallback: seleccionar todo y reemplazar tecleando
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.insertText(lyrics);
  }
  await page.waitForTimeout(300);

  // Fill Style. El campo de estilo no siempre es textarea.nth(1) — si Suno
  // reordena el DOM, ese índice llena el campo equivocado en silencio. Probamos
  // primero selectores semánticos (placeholder/aria) y caemos a nth(1) sólo si
  // ninguno aparece, para no romper si el DOM cambió.
  let styleBox = page.locator(STYLE_TEXTAREA).first();
  if ((await styleBox.count()) === 0) {
    styleBox = page.locator('textarea').nth(1);
  }
  await styleBox.click();
  await styleBox.fill(estilo);
  await page.waitForTimeout(300);

  // Expand More Options (only if not already expanded — clicking it again would collapse it).
  // expandIfCollapsed uses a 10s explicit waitFor so translation-key failures bubble up fast
  // to withReloadRetry instead of hanging 30 seconds.
  const genderButton = page.getByRole('button', { name: genderTarget, exact: true }).first();
  await expandIfCollapsed(page, MORE_OPTIONS_TOGGLE_TEXT, genderButton);

  // Vocal Gender
  await safeClick(page, genderButton, { label: `Vocal Gender (${genderTarget})`, maxAttempts: 3 });
  await page.waitForTimeout(300);

  // Sliders
  await setSliderValue(page, WEIRDNESS_SLIDER_LABEL, 55);
  await setSliderValue(page, STYLE_INFLUENCE_SLIDER_LABEL, 55);
  await page.waitForTimeout(300);

  // Title
  const titleInputs = page.locator(TITLE_INPUT);
  const titleCount = await titleInputs.count();
  let titleInput = null;
  for (let i = 0; i < titleCount; i++) {
    if (await titleInputs.nth(i).isVisible()) {
      titleInput = titleInputs.nth(i);
      break;
    }
  }
  if (!titleInput) titleInput = titleInputs.first();
  await titleInput.click();
  await titleInput.fill(titulo);
  await page.waitForTimeout(500);
}

(async () => {
  const songContent = fs.readFileSync(SONG_PATH, 'utf-8');
  const { titulo, voz, estilo, lyrics } = parseSongFile(songContent);
  if (!titulo || !voz || !estilo || !lyrics) {
    throw new Error('No se pudo parsear song.txt completamente.');
  }
  const genderTarget = /femenin/i.test(voz) ? 'Female' : 'Male';
  console.log('Parseado de song.txt:');
  console.log('  Titulo:', titulo);
  console.log('  Voz:', voz, '->', genderTarget);
  console.log('  Estilo:', estilo);
  console.log('  Lyrics length:', lyrics.length, 'chars');

  if (!(await isPortUp(9333))) {
    throw new Error('❌ Chrome no está escuchando en el puerto 9333. ¿Olvidaste iniciarlo con la flag de debugging?');
  }

  const { browser, page } = await connectToSunoTab(chromium);
  console.log('Connected to:', page.url());

  if (!page.url().includes('/create')) {
    await page.goto('https://suno.com/create', { waitUntil: 'domcontentloaded' });
  }
  await page.waitForTimeout(1000);

  try {
    // Fill the form, retrying with page.reload() if any text-based selector times
    // out (e.g. Suno rendered raw i18n keys instead of translated UI labels).
    await withReloadRetry(
      page,
      () => fillSunoForm(page, titulo, voz, estilo, lyrics, genderTarget),
      { maxAttempts: 3, description: 'formulario de Suno (Advanced mode)' }
    );
  } catch (err) {
    console.error('\n❌ Error crítico llenando el formulario de Suno:', err.message);
    await pauseForHumanInteraction('Suno cambió su interfaz o no cargó correctamente. Por favor, llena el formulario de Create manualmente.');
  }

  // --- Verification screenshots ---
  await page.screenshot({ path: 'suno-verify-overview.png' });

  // Suno le quitó el botón "Expand lyrics box" en un rediseño (data-testid y
  // aria-label ya no existen) — antes, si no se encontraba, el bloque entero se
  // saltaba en silencio y dejaba flotando el PNG de la corrida anterior con
  // pinta de estar actualizado (visto en vivo: overview.png con timestamp de
  // ahora, lyrics-expanded.png con el de una canción de horas antes). Eso
  // rompe justo la verificación visual que este proyecto trata como
  // no-negociable. Mientras Suno no reintroduzca el botón, el fallback
  // scrollea el editor de letra al inicio (para ver Verse 1, no el final
  // donde queda el cursor) y saca un screenshot con OTRO nombre de archivo —
  // nunca reusar 'suno-verify-lyrics-expanded.png' a medias, y borrar el
  // viejo si quedó de una corrida anterior para que no lo confundan con uno
  // fresco.
  const OLD_EXPANDED_PATH = 'suno-verify-lyrics-expanded.png';
  const expandBtn = page.getByLabel(EXPAND_LYRICS_BOX_LABEL);
  if ((await expandBtn.count()) > 0) {
    await expandBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: OLD_EXPANDED_PATH });
    await expandBtn.click().catch(() => {});
    await page.waitForTimeout(300);
  } else {
    console.log(`  ⚠️ "${EXPAND_LYRICS_BOX_LABEL}" ya no existe en la UI de Suno (rediseño) — usando fallback de scroll-to-top.`);
    if (fs.existsSync(OLD_EXPANDED_PATH)) {
      fs.unlinkSync(OLD_EXPANDED_PATH);
      console.log(`  🗑️  Borrado ${OLD_EXPANDED_PATH} viejo para que no se confunda con uno de esta corrida.`);
    }
    const lyricsBoxForScroll = page.locator(LYRICS_TEXTAREA).first();
    // scrollIntoViewIfNeeded scrollea el panel CONTENEDOR (que tiene su propio
    // scroll, separado del de la letra) para que la caja de letra quede
    // visible — sin esto, el panel queda donde lo dejó el llenado de Título/
    // More Options más abajo, y el screenshot termina mostrando el cuadro de
    // Estilo en vez del de Letra aunque el scroll INTERNO de la letra esté en 0.
    await lyricsBoxForScroll.scrollIntoViewIfNeeded().catch(() => {});
    await lyricsBoxForScroll.evaluate((el) => { el.scrollTop = 0; }).catch(() => {});
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'suno-verify-lyrics-top.png' });
  }

  // Re-acquire locators for verification (they were filled inside fillSunoForm)
  const lyricsBox = page.locator(LYRICS_TEXTAREA).first();
  let styleBox = page.locator(STYLE_TEXTAREA).first();
  if ((await styleBox.count()) === 0) styleBox = page.locator('textarea').nth(1);
  const titleInputs = page.locator(TITLE_INPUT);
  let titleInput = null;
  for (let i = 0; i < await titleInputs.count(); i++) {
    if (await titleInputs.nth(i).isVisible()) { titleInput = titleInputs.nth(i); break; }
  }
  if (!titleInput) titleInput = titleInputs.first();

  const lyricsValue = await lyricsBox.evaluate(el => el.value !== undefined ? el.value : el.innerText).catch(() => '');
  const styleValue = await styleBox.inputValue();
  const titleValue = await titleInput.inputValue();
  const weirdnessVal = await page.locator(`[role="slider"][aria-label="${WEIRDNESS_SLIDER_LABEL}"]`).getAttribute('aria-valuenow');
  const influenceVal = await page.locator(`[role="slider"][aria-label="${STYLE_INFLUENCE_SLIDER_LABEL}"]`).getAttribute('aria-valuenow');

  console.log('\n--- Valores leidos del formulario ---');
  console.log('Title:', titleValue);
  console.log('Style:', styleValue);
  console.log('Weirdness:', weirdnessVal, 'Style Influence:', influenceVal);
  console.log('Lyrics value length:', lyricsValue.length);
  console.log(
    'Lyrics contains all sections:',
    ['[Verse 1]', '[Chorus 1]', '[Verse 2]', '[Chorus 2]', '[Bridge]', '[Outro]'].every((s) => lyricsValue.includes(s))
  );
  console.log('Lyrics ends correctly:', lyricsValue.trim().endsWith(lyrics.trim().split('\n').pop().trim()));

  console.log('\nFormulario completado. Revisando screenshots.');

  // Desconectar la sesión CDP para que Node pueda terminar. Sobre connectOverCDP,
  // browser.close() SOLO desconecta el socket — Chrome queda abierto con el
  // formulario intacto (verificado empíricamente en Playwright 1.61; sin esto
  // el proceso queda colgado y start-flow.js espera para siempre).
  await browser.close().catch(() => {});
})().catch((err) => {
  console.error('Automation failed:', err);
  process.exit(1);
});
