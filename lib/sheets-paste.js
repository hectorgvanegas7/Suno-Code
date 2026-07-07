// lib/sheets-paste.js — Automatiza el gesto que Gabo hacía a mano: pegar el
// screenshot "flotando sobre la celda" en la hoja de Google Sheets. La API
// REST de Sheets no tiene una forma limpia de crear ese objeto flotante (es
// distinto de =IMAGE() y de "insertar imagen en la celda"), así que en vez
// de pelear con eso simulamos el mismo Ctrl+V que hace un humano, sobre el
// Chrome ya compartido del pipeline (puerto 9333) — mismo enfoque que el
// resto del repo usa para automatizar UI compleja (Suno, el Flow).
//
// copyImageToClipboard nunca lanza (fail-open: si PowerShell falla, el
// caller sigue con el flujo normal). tryAutoPasteScreenshot SÍ lanza ante
// cualquier duda (Chrome cerrado, name box no coincide, timeout) — el
// caller decide el fallback (avisar por ntfy, la imagen ya quedó en el
// portapapeles gracias a copyImageToClipboard).

const { execFileSync } = require('child_process');

function escapePsSingleQuoted(str) {
  return str.replace(/'/g, "''");
}

// Pone el PNG en el portapapeles de Windows como imagen real (no como
// referencia a archivo) para que un Ctrl+V en cualquier app lo pegue como
// imagen — igual que copiar una imagen desde un visor y pegarla. Requiere
// -sta: Clipboard.SetImage tira una excepción de threading sin modo STA.
function copyImageToClipboard(localPngPath) {
  const escapedPath = escapePsSingleQuoted(localPngPath);
  const command = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    `$img = [System.Drawing.Image]::FromFile('${escapedPath}')`,
    '[System.Windows.Forms.Clipboard]::SetImage($img)',
    '$img.Dispose()',
  ].join('; ');

  try {
    execFileSync('powershell', ['-sta', '-NoProfile', '-Command', command], { stdio: 'ignore' });
    return true;
  } catch (e) {
    console.log(`⚠️ No se pudo copiar el screenshot al portapapeles: ${e.message.substring(0, 120)}`);
    return false;
  }
}

// Abre una pestaña NUEVA (nunca reusa las de Gabo) en el Chrome compartido,
// navega directo a la celda vía el parámetro range= de la URL, confirma que
// el name box realmente muestra esa celda (para no arriesgar pegar en el
// lugar equivocado en una hoja de producción) y dispara un Ctrl+V real.
// Lanza si algo no se puede confirmar — el caller decide el fallback.
async function tryAutoPasteScreenshot({ spreadsheetId, sheetId, row, debugPort = 9333 }) {
  if (sheetId === undefined || sheetId === null) {
    throw new Error('Falta sheetId numérico del tab — no se puede armar la URL de la celda.');
  }
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP(`http://localhost:${debugPort}`);
  const contexts = browser.contexts();
  if (contexts.length === 0) throw new Error('No hay contextos de navegador disponibles en el Chrome compartido.');
  const context = contexts[0];

  const expectedCell = `H${row}`;
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetId}&range=${expectedCell}`;

  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Dar tiempo a que Sheets renderice la grilla (canvas) y posicione la celda.
    await page.waitForTimeout(2500);

    const nameBox = page.locator('#t-name-box');
    await nameBox.waitFor({ state: 'visible', timeout: 10000 });
    const cellRef = (await nameBox.inputValue()).trim().toUpperCase();
    if (cellRef !== expectedCell) {
      throw new Error(`Name box muestra "${cellRef}", esperaba "${expectedCell}" — no pego para no arriesgar la celda equivocada.`);
    }

    await page.keyboard.press('Control+V');
    // Dar tiempo a que Sheets procese el paste antes de cerrar la pestaña.
    await page.waitForTimeout(1500);
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { copyImageToClipboard, tryAutoPasteScreenshot };
