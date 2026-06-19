const { chromium } = require('playwright');

const USER_DATA_DIR = 'C:\\Users\\hecto\\AppData\\Local\\ChromeAutomationProfile';
const PROFILE_DIRECTORY = 'Profile 1';

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: false,
    slowMo: 100,
    args: [`--profile-directory=${PROFILE_DIRECTORY}`],
    viewport: { width: 1440, height: 900 },
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto('https://suno.com/create', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2000);

    const info = await page.evaluate(() => {
      function describe(el) {
        return {
          tag: el.tagName,
          type: el.type || null,
          id: el.id || null,
          name: el.name || null,
          placeholder: el.placeholder || null,
          ariaLabel: el.getAttribute('aria-label'),
          role: el.getAttribute('role'),
          className: el.className && el.className.toString().slice(0, 120),
          text: el.textContent ? el.textContent.trim().slice(0, 60) : null,
          dataTestId: el.getAttribute('data-testid'),
        };
      }
      const inputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]')).map(describe);
      const buttons = Array.from(document.querySelectorAll('button')).map(describe);
      return { inputs, buttons };
    });

    require('fs').writeFileSync('suno-dom-info.json', JSON.stringify(info, null, 2));
    console.log('Saved DOM info. Inputs:', info.inputs.length, 'Buttons:', info.buttons.length);
  } finally {
    await context.close();
  }
})().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
