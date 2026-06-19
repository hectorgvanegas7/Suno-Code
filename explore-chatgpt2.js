const { chromium } = require('playwright');
const path = require('path');

const USER_DATA_DIR = 'C:\\Users\\hecto\\AppData\\Local\\ChromeAutomationProfile';
const PROFILE_DIRECTORY = 'Profile 1';

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: false,
    args: [`--profile-directory=${PROFILE_DIRECTORY}`],
    viewport: { width: 1440, height: 900 },
  });

  context.on('close', () => console.log('>>> CONTEXT CLOSED EVENT'));

  const page = await context.newPage();
  page.on('close', () => console.log('>>> PAGE CLOSED EVENT'));
  page.on('crash', () => console.log('>>> PAGE CRASHED EVENT'));

  await page.goto('https://chatgpt.com/', { waitUntil: 'load' });
  await page.bringToFront();

  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const url = page.url();
      const title = await page.title();
      console.log(`[t=${(i + 1) * 5}s] alive, url=${url} title=${title}`);
    } catch (err) {
      console.log(`[t=${(i + 1) * 5}s] ERROR: ${err.message}`);
      break;
    }
  }

  console.log('Done polling, closing.');
  await context.close().catch(() => {});
})().catch((err) => {
  console.error('Explore2 failed:', err.message);
  process.exit(1);
});
