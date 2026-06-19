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

  const page = await context.newPage();
  await page.goto('https://chatgpt.com/', { waitUntil: 'load' });
  await page.bringToFront();
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(4000);
  await page.bringToFront();

  console.log('URL:', page.url());
  console.log('Title:', await page.title());
  await page.screenshot({ path: path.join(__dirname, 'chatgpt-debug-1-initial.png'), fullPage: true });

  const loggedOut = await page.getByText('Log in', { exact: true }).count();
  if (loggedOut > 0) {
    console.log('\nNot logged in to ChatGPT in this profile.');
    console.log('Please log in manually in the Chrome window that just opened.');
    console.log('Waiting up to 5 minutes...\n');
    await page.getByText('Log in', { exact: true }).first().waitFor({ state: 'detached', timeout: 300000 }).catch(() => {});
    await page.waitForTimeout(2000);
    console.log('Continuing after login. URL now:', page.url());
  }

  // Dump sidebar-ish nav text to find the project name and structure
  const navText = await page.evaluate(() => {
    const nav = document.querySelector('nav') || document.body;
    return nav.innerText.slice(0, 3000);
  });
  console.log('--- NAV TEXT ---');
  console.log(navText);

  // Look for elements that look like project entries
  const possibleProjectLinks = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('a, [role="link"], li, button'));
    return els
      .map((el) => el.textContent.trim())
      .filter((t) => t && t.length > 0 && t.length < 60)
      .filter((t, i, arr) => arr.indexOf(t) === i)
      .slice(0, 150);
  });
  console.log('--- CANDIDATE TEXTS ---');
  console.log(JSON.stringify(possibleProjectLinks, null, 2));

  console.log('\nLeaving window open for 60s for manual inspection / login if needed...');
  await page.waitForTimeout(60000);
  await context.close();
})().catch((err) => {
  console.error('Explore failed:', err);
  process.exit(1);
});
