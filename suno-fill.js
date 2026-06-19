const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const USER_DATA_DIR = 'C:\\Users\\hecto\\AppData\\Local\\ChromeAutomationProfile';
const PROFILE_DIRECTORY = 'Profile 1';
const SONG_PATH = path.join(__dirname, 'song.txt');
const DEBUG_PORT = 9333;

function parseSongFile(content) {
  const titulo = (content.match(/\*\*Título:\*\*\s*(.+)/i) || [])[1]?.trim();
  const voz = (content.match(/\*\*Voz:\*\*\s*(.+)/i) || [])[1]?.trim();
  const estilo = (content.match(/\*\*Estilo Suno:\*\*\s*(.+)/i) || [])[1]?.trim();
  const verseIndex = content.search(/\[Verse 1\]/i);
  const advertenciasIndex = content.search(/\*\*Advertencias:\*\*/i);
  const notesIndex = content.search(/NOTES:/i);
  const endIndex = [advertenciasIndex, notesIndex].filter((i) => i !== -1).sort((a, b) => a - b)[0];
  const lyrics = content.slice(verseIndex, endIndex === undefined ? undefined : endIndex).trim();
  return { titulo, voz, estilo, lyrics };
}

async function setSliderValue(page, ariaLabel, targetValue) {
  const slider = page.locator(`[role="slider"][aria-label="${ariaLabel}"]`);
  await slider.scrollIntoViewIfNeeded();
  await slider.click();
  for (let i = 0; i < 200; i++) {
    const current = parseInt(await slider.getAttribute('aria-valuenow'), 10);
    if (current === targetValue) break;
    await page.keyboard.press(current < targetValue ? 'ArrowRight' : 'ArrowLeft');
    await page.waitForTimeout(80);
  }
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

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: false,
    slowMo: 120,
    args: [`--profile-directory=${PROFILE_DIRECTORY}`, `--remote-debugging-port=${DEBUG_PORT}`],
    viewport: { width: 1440, height: 1000 },
  });

  context.on('dialog', (d) => d.accept().catch(() => {}));

  const page = context.pages()[0] || (await context.newPage());
  page.on('dialog', (d) => d.accept().catch(() => {}));

  await page.goto('https://suno.com/create', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);

  // Reset form to a clean baseline
  const clearBtn = page.getByLabel('Clear all form inputs');
  if (await clearBtn.count() > 0) {
    await clearBtn.click().catch(() => {});
    await page.waitForTimeout(1000);
  }

  // Ensure Advanced tab active
  const advancedTab = page.getByRole('tab', { name: 'Advanced' });
  if (await advancedTab.count() > 0) {
    const cls = (await advancedTab.getAttribute('class')) || '';
    if (!cls.includes('active')) await advancedTab.click();
  }
  await page.waitForTimeout(500);

  // Ensure "Write" lyrics sub-mode
  const writeTab = page.getByRole('radio', { name: 'Write' });
  if (await writeTab.count() > 0) await writeTab.click().catch(() => {});
  await page.waitForTimeout(300);

  // Fill Lyrics
  const lyricsBox = page.locator('[data-testid="lyrics-textarea"]');
  await lyricsBox.click();
  await lyricsBox.fill(lyrics);
  await page.waitForTimeout(300);

  // Fill Style (second textarea on the Advanced/Write panel)
  const styleBox = page.locator('textarea').nth(1);
  await styleBox.click();
  await styleBox.fill(estilo);
  await page.waitForTimeout(300);

  // Expand More Options (only if not already expanded — clicking it again would collapse it)
  const genderButton = page.getByRole('button', { name: genderTarget, exact: true }).first();
  if ((await genderButton.count()) === 0 || !(await genderButton.isVisible())) {
    await page.getByText('More Options', { exact: false }).first().click();
    await page.waitForTimeout(500);
  }

  // Vocal Gender
  await genderButton.click();
  await page.waitForTimeout(300);

  // Sliders
  await setSliderValue(page, 'Weirdness', 55);
  await setSliderValue(page, 'Style Influence', 55);
  await page.waitForTimeout(300);

  // Title
  const titleInputs = page.locator('input[placeholder="Song Title (Optional)"]');
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

  // Screenshot 1: overview
  await page.screenshot({ path: 'suno-verify-overview.png' });

  // Screenshot 2: expanded lyrics for full visual check
  const expandBtn = page.getByLabel('Expand lyrics box');
  if (await expandBtn.count() > 0) {
    await expandBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'suno-verify-lyrics-expanded.png' });
    await expandBtn.click().catch(() => {});
    await page.waitForTimeout(300);
  }

  // Read back values for a programmatic sanity check (logged only, not blocking)
  const lyricsValue = await lyricsBox.inputValue();
  const styleValue = await styleBox.inputValue();
  const titleValue = await titleInput.inputValue();
  const weirdnessVal = await page.locator('[role="slider"][aria-label="Weirdness"]').getAttribute('aria-valuenow');
  const influenceVal = await page.locator('[role="slider"][aria-label="Style Influence"]').getAttribute('aria-valuenow');

  console.log('\n--- Valores leidos del formulario ---');
  console.log('Title:', titleValue);
  console.log('Style:', styleValue);
  console.log('Weirdness:', weirdnessVal, 'Style Influence:', influenceVal);
  console.log('Lyrics value length:', lyricsValue.length);
  console.log('Lyrics contains all sections:', ['[Verse 1]', '[Chorus 1]', '[Verse 2]', '[Chorus 2]', '[Bridge]', '[Outro]'].every(s => lyricsValue.includes(s)));
  console.log('Lyrics ends correctly:', lyricsValue.trim().endsWith(lyrics.trim().split('\n').pop().trim()));

  console.log(`\nFormulario completado. Chrome sigue abierto con debugging port ${DEBUG_PORT}.`);
  console.log('Revisando screenshots: suno-verify-overview.png y suno-verify-lyrics-expanded.png');

  // Keep process (and browser) alive
  await new Promise(() => {});
})().catch((err) => {
  console.error('Automation failed:', err);
});
