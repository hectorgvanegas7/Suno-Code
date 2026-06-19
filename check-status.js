const { chromium } = require('playwright');
const path = require('path');

const USER_DATA_DIR = 'C:\\Users\\hecto\\AppData\\Local\\ChromeAutomationProfile';
const PROFILE_DIRECTORY = 'Profile 1';
const TARGET_URL = 'https://cancioneterna.com/artists/flow';

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: false,
    args: [`--profile-directory=${PROFILE_DIRECTORY}`],
    viewport: { width: 1440, height: 900 },
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500);

    console.log('URL:', page.url());
    console.log('Title:', await page.title());

    const enterFlowBtn = page.getByText('Enter Flow', { exact: false }).first();
    if (await enterFlowBtn.count()) {
      await enterFlowBtn.click();
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(1500);
    }

    console.log('URL after Enter Flow:', page.url());
    const bodyText = await page.evaluate(() => document.body.innerText);
    console.log('--- PAGE TEXT (first 4000 chars) ---');
    console.log(bodyText.slice(0, 4000));

    await page.screenshot({ path: path.join(__dirname, 'status-check.png'), fullPage: true });
    console.log('Screenshot guardado en status-check.png');
  } finally {
    await context.close();
  }
})().catch((err) => {
  console.error('Check failed:', err);
  process.exit(1);
});
