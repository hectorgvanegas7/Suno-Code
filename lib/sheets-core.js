// lib/sheets-core.js — Lógica de registro en Google Sheets, extraída de
// sheets.js para que pueda llamarse como función (desde start-flow --done)
// además de como script standalone (node sheets.js).
//
// Llena siempre: Date (A), Total Songs (B), Title (E), Song ID (F).
// Llena cuando se pasan: Total Time (C), Time (D) — extraídos de "Recent completions".
// Deja vacías: Remarks (G), Flow Screenshot (H) — esas las llena Gabo a mano.
//
// El comportamiento es idéntico al sheets.js original; sólo cambió el empaque
// (función exportada + parámetros) para reutilizarlo sin duplicar código.

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { parseSongFile } = require('./song-file');

const DEFAULT_SONG_PATH = path.join(__dirname, '..', 'song.txt');
const SPREADSHEET_ID = '1UAJK4EVmkdeVmBIHeXCdp4hXLGwzT9UvFV0829T2Tro';

function getTodayFormatted() {
  const now = new Date();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(now.getDate()).padStart(2, '0');
  return `${day}-${months[now.getMonth()]}-${now.getFullYear()}`;
}

async function pickWorkingTab(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const tabTitles = meta.data.sheets.map((s) => s.properties.title);

  const MONTHS = {
    JANUARY: 0, FEBRUARY: 1, MARCH: 2, APRIL: 3, MAY: 4, JUNE: 5,
    JULY: 6, AUGUST: 7, SEPTEMBER: 8, OCTOBER: 9, NOVEMBER: 10, DECEMBER: 11,
    JAN: 0, FEB: 1, MAR: 2, APR: 3, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };

  let best = null;
  let bestRank = -1;
  for (const title of tabTitles) {
    const m = title.trim().toUpperCase().match(/^([A-Z]+)\s+(\d{4})$/);
    if (!m) continue;
    const monthIdx = MONTHS[m[1]];
    if (monthIdx === undefined) continue;
    const year = parseInt(m[2], 10);
    const rank = year * 12 + monthIdx;
    if (rank > bestRank) {
      bestRank = rank;
      best = title;
    }
  }

  if (!best) {
    throw new Error('No se encontró ningún tab con formato "MES AÑO" (ej. "JULY 2026").');
  }
  return best;
}

async function getFirstEmptyRow(sheets, tabName) {
  const range = `${tabName}!A1:F`;
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const rows = response.data.values || [];
  const START_INDEX = 6; // header en fila 5, ejemplo en fila 6 -> empezamos en la 7
  for (let i = START_INDEX; i < rows.length; i++) {
    const row = rows[i] || [];
    const title = (row[4] || '').trim();   // col E
    const songId = (row[5] || '').trim();  // col F
    if (!title && !songId) return i + 1;   // 1-indexed
  }
  return rows.length + 1;
}

async function songIdAlreadyExists(sheets, tabName, songId) {
  const range = `${tabName}!F1:F`;
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const rows = response.data.values || [];
  return rows.some((r) => (r[0] || '').trim() === songId);
}

// Registra la canción de song.txt en la hoja. Devuelve un objeto con el
// resultado: { written: bool, reason, row, tabName, titulo, songId }.
// No hace process.exit — eso queda para quien lo llame.
async function logSongToSheet({ songPath = DEFAULT_SONG_PATH, log = console.log, timeHHMM = null, totalTimeDecimal = null } = {}) {
  if (!fs.existsSync(songPath)) {
    throw new Error('song.txt no encontrado. Corré primero el flujo de generación.');
  }
  const CRED_PATH = path.join(__dirname, '..', 'oauth-credentials.json');
  const TOKEN_PATH = path.join(__dirname, '..', 'token.json');
  if (!fs.existsSync(CRED_PATH) || !fs.existsSync(TOKEN_PATH)) {
    throw new Error('Faltan oauth-credentials.json o token.json para autenticar con Google.');
  }

  const creds = JSON.parse(fs.readFileSync(CRED_PATH, 'utf-8'));
  const { client_secret, client_id, redirect_uris } = creds.installed;
  const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0] || 'http://localhost');
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
  auth.setCredentials(token);

  const sheets = google.sheets({ version: 'v4', auth });

  const songContent = fs.readFileSync(songPath, 'utf-8');
  const { titulo, songId } = parseSongFile(songContent);
  if (!titulo) throw new Error('No se encontró el Título en song.txt.');
  if (!songId) throw new Error('No se encontró el Song ID en song.txt (línea NOTES).');

  log(`📄 Título: ${titulo}`);
  log(`🎵 Song ID: ${songId}`);

  const tabName = await pickWorkingTab(sheets);
  log(`📊 Tab de trabajo: ${tabName}`);

  if (await songIdAlreadyExists(sheets, tabName, songId)) {
    log(`\n⚠️ El Song ID ${songId} YA está registrado en ${tabName}. No se escribió nada (anti-duplicado).`);
    return { written: false, reason: 'duplicate', tabName, titulo, songId };
  }

  const firstEmptyRow = await getFirstEmptyRow(sheets, tabName);
  log(`📝 Escribiendo en fila ${firstEmptyRow}...`);

  const today = getTodayFormatted();
  const data = [
    { range: `${tabName}!A${firstEmptyRow}`, values: [[today]] },
    { range: `${tabName}!B${firstEmptyRow}`, values: [[1]] },
    { range: `${tabName}!E${firstEmptyRow}`, values: [[titulo]] },
    { range: `${tabName}!F${firstEmptyRow}`, values: [[songId]] },
  ];
  if (totalTimeDecimal !== null) {
    data.push({ range: `${tabName}!C${firstEmptyRow}`, values: [[totalTimeDecimal]] });
  }
  if (timeHHMM !== null) {
    data.push({ range: `${tabName}!D${firstEmptyRow}`, values: [[timeHHMM]] });
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });

  log(`\n✅ Fila ${firstEmptyRow} en ${tabName} llenada:`);
  log(`   Date: ${today}`);
  log(`   Total Songs: 1`);
  if (totalTimeDecimal !== null) log(`   Total Time: ${totalTimeDecimal}`);
  if (timeHHMM !== null) log(`   Time: ${timeHHMM}`);
  log(`   Title: ${titulo}`);
  log(`   Song ID: ${songId}`);

  return { written: true, reason: 'ok', row: firstEmptyRow, tabName, titulo, songId };
}

module.exports = { logSongToSheet, parseSongFile, SPREADSHEET_ID };
