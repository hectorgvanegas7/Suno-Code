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
    await page.waitForTimeout(1500);

    await page.getByText('More Options', { exact: false }).first().click();
    await page.waitForTimeout(1000);

    const sliderInfo = await page.evaluate(() => {
      function describe(el) {
        return {
          tag: el.tagName,
          role: el.getAttribute('role'),
          ariaLabel: el.getAttribute('aria-label'),
          ariaValueNow: el.getAttribute('aria-valuenow'),
          ariaValueMin: el.getAttribute('aria-valuemin'),
          ariaValueMax: el.getAttribute('aria-valuemax'),
          className: el.className && el.className.toString().slice(0, 120),
          text: el.textContent ? el.textContent.trim().slice(0, 40) : null,
        };
      }
      const sliders = Array.from(document.querySelectorAll('[role="slider"], input[type="range"]')).map(describe);
      // Also grab the "More Options" panel container text for context
      const panels = Array.from(document.querySelectorAll('div')).filter(d => {
        const t = Array.from(d.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
        return t === 'Vocal Gender' || t === 'Weirdness' || t === 'Style Influence';
      });
      const context = panels.map(p => {
        const parent = p.closest('div')?.parentElement;
        return parent ? parent.outerHTML.slice(0, 800) : null;
      });
      return { sliders, context };
    });

    require('fs').writeFileSync('suno-slider-info.json', JSON.stringify(sliderInfo, null, 2));
    console.log('Sliders found:', sliderInfo.sliders.length);

    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'suno-explore5.png' });
    console.log('Done.');
  } finally {
    await context.close();
  }
})().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
