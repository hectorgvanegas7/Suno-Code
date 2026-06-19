const { chromium } = require('playwright');
const path = require('path');

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

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    await clickByText(page, 'Enter Flow');
    await page.waitForLoadState('networkidle').catch(() => {});

    await clickByText(page, 'Assign Most Urgent Song');
    await page.waitForTimeout(2000);
    await page.waitForLoadState('networkidle').catch(() => {});

    const html = await page.evaluate(() => {
      const heading = Array.from(document.querySelectorAll('*')).find(
        (el) => el.textContent.trim() === 'Survey Responses' && el.children.length === 0
      );
      if (!heading) return 'HEADING NOT FOUND';
      // walk up to find a reasonably-sized container
      let node = heading;
      for (let i = 0; i < 6 && node.parentElement; i++) {
        node = node.parentElement;
      }
      return node.outerHTML;
    });

    require('fs').writeFileSync(path.join(__dirname, 'survey-section.html'), html);
    console.log('Saved survey-section.html, length:', html.length);

    // Also try to find Title and Lyrics input/textarea elements
    const fieldsInfo = await page.evaluate(() => {
      const describe = (el) => ({
        tag: el.tagName,
        type: el.type || null,
        id: el.id || null,
        name: el.name || null,
        placeholder: el.placeholder || null,
        contentEditable: el.isContentEditable,
        nearbyLabel: (() => {
          let p = el;
          for (let i = 0; i < 4 && p; i++) {
            const t = p.previousElementSibling && p.previousElementSibling.textContent;
            if (t && t.trim().length < 40 && t.trim().length > 0) return t.trim();
            p = p.parentElement;
          }
          return null;
        })(),
      });
      const inputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]'));
      return inputs.map(describe);
    });
    console.log('--- FIELDS ---');
    console.log(JSON.stringify(fieldsInfo, null, 2));

    await page.waitForTimeout(3000);
  } finally {
    await context.close();
  }
})().catch((err) => {
  console.error('Explore-survey failed:', err);
  process.exit(1);
});
