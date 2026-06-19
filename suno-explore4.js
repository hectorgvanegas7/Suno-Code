const { chromium } = require('playwright');

const USER_DATA_DIR = 'C:\\Users\\hecto\\AppData\\Local\\ChromeAutomationProfile';
const PROFILE_DIRECTORY = 'Profile 1';

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: false,
    slowMo: 100,
    args: [`--profile-directory=${PROFILE_DIRECTORY}`],
    viewport: { width: 1440, height: 1000 },
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto('https://suno.com/create', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2000);

    const matches = await page.evaluate(() => {
      const re = /more options|weirdness|style influence|vocal gender/i;
      const all = Array.from(document.querySelectorAll('body *'));
      const found = [];
      for (const el of all) {
        const ownText = Array.from(el.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent.trim())
          .join(' ')
          .trim();
        if (ownText && re.test(ownText)) {
          found.push({
            tag: el.tagName,
            text: ownText.slice(0, 60),
            className: el.className && el.className.toString().slice(0, 100),
            role: el.getAttribute('role'),
          });
        }
      }
      return found;
    });

    require('fs').writeFileSync('suno-more-options.json', JSON.stringify(matches, null, 2));
    console.log('Matches found:', matches.length);
    console.log(JSON.stringify(matches, null, 2));

    // Try clicking a "More Options" element directly if found
    const moreOptionsLocator = page.getByText('More Options', { exact: false });
    const count = await moreOptionsLocator.count();
    console.log('More Options locator count:', count);
    if (count > 0) {
      await moreOptionsLocator.first().click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: 'suno-after-more-options.png' });
      console.log('Clicked More Options and screenshotted.');
    }
  } finally {
    await context.close();
  }
})().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
