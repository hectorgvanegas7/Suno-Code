const { chromium } = require('playwright');

const USER_DATA_DIR = 'C:\\Users\\hecto\\AppData\\Local\\ChromeAutomationProfile';
const PROFILE_DIRECTORY = 'Profile 1';

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: false,
    args: [`--profile-directory=${PROFILE_DIRECTORY}`],
    viewport: { width: 1440, height: 900 },
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://suno.com/create', { waitUntil: 'domcontentloaded' });
  console.log('Browser open. Log in manually, then let Claude know.');
  // Leave the browser open and the process running so the context stays alive.
  await new Promise(() => {});
})().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
