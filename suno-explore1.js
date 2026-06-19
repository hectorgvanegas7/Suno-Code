const { chromium } = require('playwright');

const USER_DATA_DIR = 'C:\\Users\\hecto\\AppData\\Local\\ChromeAutomationProfile';
const PROFILE_DIRECTORY = 'Profile 1';

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: false,
    slowMo: 200,
    args: [`--profile-directory=${PROFILE_DIRECTORY}`],
    viewport: { width: 1440, height: 900 },
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto('https://suno.com/create', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'suno-explore1.png', fullPage: false });
    console.log('URL:', page.url());
  } finally {
    await context.close();
  }
})().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
