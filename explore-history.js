// One-off exploration script: find a completed song by title and report
// time spent. Not part of the regular run.js / submit.js flow.
const { chromium } = require('playwright');
const path = require('path');

const USER_DATA_DIR = 'C:\\Users\\hecto\\AppData\\Local\\ChromeAutomationProfile';
const PROFILE_DIRECTORY = 'Profile 1';
const BASE_URL = 'https://cancioneterna.com';
const SEARCH_TERM = 'cielo en septiembre';

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: false,
    args: [`--profile-directory=${PROFILE_DIRECTORY}`],
    viewport: { width: 1440, height: 900 },
  });

  try {
    const page = context.pages()[0] || (await context.newPage());

    await page.goto(`${BASE_URL}/artists/flow`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500);

    if (page.url().includes('/sign-in')) {
      console.log('\nNo hay sesión activa. Iniciá sesión manualmente (esperando hasta 5 minutos)...\n');
      await page.waitForURL((url) => !url.toString().includes('/sign-in'), { timeout: 300000 });
      await page.goto(`${BASE_URL}/artists/flow`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
    }

    console.log('URL:', page.url());

    const navLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a'))
        .map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') }))
        .filter((l) => l.text)
    );
    console.log('--- LINKS ENCONTRADOS ---');
    navLinks.forEach((l) => console.log(`${l.text} -> ${l.href}`));

    const bodyText = await page.evaluate(() => document.body.innerText);
    console.log('--- TEXTO DE LA PÁGINA (primeros 3000 chars) ---');
    console.log(bodyText.slice(0, 3000));

    console.log('\nClicking "Enter Flow"...');
    await page.getByText('Enter Flow', { exact: false }).first().click();
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500);

    console.log('URL tras Enter Flow:', page.url());

    const innerLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a, button'))
        .map((a) => a.textContent.trim())
        .filter(Boolean)
    );
    console.log('--- BOTONES/LINKS EN /artists/flow/create ---');
    innerLinks.forEach((l) => console.log(l));

    const innerText = await page.evaluate(() => document.body.innerText);
    console.log('--- TEXTO DE /artists/flow/create (primeros 4000 chars) ---');
    console.log(innerText.slice(0, 4000));

    await page.screenshot({ path: path.join(__dirname, 'explore-flow-create.png'), fullPage: true });
    console.log('Screenshot guardado en explore-flow-create.png');

    await page.screenshot({ path: path.join(__dirname, 'explore-artists.png'), fullPage: true });
    console.log('Screenshot guardado en explore-artists.png');
  } finally {
    await context.close();
  }
})().catch((err) => {
  console.error('Explore failed:', err);
  process.exit(1);
});
