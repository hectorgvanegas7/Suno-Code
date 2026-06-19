const { chromium } = require('playwright');

const USER_DATA_DIR = 'C:\\Users\\hecto\\AppData\\Local\\ChromeAutomationProfile';
const PROFILE_DIRECTORY = 'Profile 1';
const TARGET_URL = 'https://cancioneterna.com/artists/flow';

async function clickByText(page, text) {
  const locator = page.getByRole('button', { name: text, exact: false })
    .or(page.getByRole('link', { name: text, exact: false }))
    .or(page.getByText(text, { exact: false }));
  await locator.first().waitFor({ state: 'visible', timeout: 20000 });
  await locator.first().click();
}

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: false,
    args: [`--profile-directory=${PROFILE_DIRECTORY}`],
    viewport: { width: 1440, height: 900 },
  });

  const page = context.pages()[0] || (await context.newPage());

  page.on('request', (req) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method())) {
      console.log(`>>> ${req.method()} ${req.url()}`);
    }
  });

  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await clickByText(page, 'Enter Flow');
  await page.waitForLoadState('networkidle').catch(() => {});

  console.log('Filling title + lyrics, then watching network for 40s...');
  await page.locator('#title').fill('AUTOSAVE TEST TITLE');
  await page.locator('#lyrics').fill('AUTOSAVE TEST LYRICS LINE 1\nLINE 2');
  await page.locator('#lyrics').blur();

  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(5000);
    console.log(`...${(i + 1) * 5}s elapsed, no save request seen yet (if nothing printed above)`);
  }

  await context.close();
})().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
