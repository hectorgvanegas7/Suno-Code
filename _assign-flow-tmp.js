const { chromium } = require('playwright');
const { clickByText } = require('./lib/playwright-helpers');

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9333');
  const context = browser.contexts()[0];
  const pages = context.pages();
  const page = pages.find((p) => p.url().includes('cancioneterna.com')) || pages[0];
  await page.bringToFront();

  console.log('Clicking Assign Most Urgent Song...');
  await clickByText(page, 'Assign Most Urgent Song');
  await page.waitForTimeout(3000);
  await page.waitForLoadState('networkidle').catch(() => {});
  console.log('URL:', page.url());
  await page.screenshot({ path: '_flow-state.png' });

  const fields = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('input, textarea').forEach((el) => {
      let label = el.closest('label')?.innerText || null;
      if (!label && el.id) {
        const lbl = document.querySelector(`label[for="${el.id}"]`);
        label = lbl ? lbl.innerText : null;
      }
      out.push({
        tag: el.tagName,
        id: el.id,
        name: el.name,
        placeholder: el.placeholder,
        ariaLabel: el.getAttribute('aria-label'),
        type: el.type,
        valuePreview: (el.value || '').slice(0, 40),
        label,
      });
    });
    return out;
  });
  console.log('Fields:', JSON.stringify(fields, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
