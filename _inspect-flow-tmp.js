const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9333');
  const context = browser.contexts()[0];
  const pages = context.pages();
  console.log('Open tabs:');
  pages.forEach((p, i) => console.log(' ', i, p.url()));
  const page = pages.find((p) => p.url().includes('cancioneterna.com')) || pages[0];
  await page.bringToFront();
  await page.waitForLoadState('networkidle').catch(() => {});
  console.log('Inspecting:', page.url());

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
  console.log(JSON.stringify(fields, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
