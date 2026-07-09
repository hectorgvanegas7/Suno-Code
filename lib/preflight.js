// lib/preflight.js — Chequeo rápido antes de arrancar el flujo, para fallar
// temprano y claro en vez de a la mitad de una canción.
//
// Verifica lo barato y lo que más rompe:
//   1. ANTHROPIC_API_KEY presente.
//   2. oauth-credentials.json + token.json presentes (lo necesita el
//      registro en la hoja y la subida de screenshots — ver auth.js).
//   3. Playwright instalado (node_modules ok).
//
// NO verifica Chrome/Suno acá — eso lo maneja start-flow más adelante con su
// propio flujo de login (lanza la ventana y espera). El preflight es sólo para
// cosas que, si faltan, no tiene sentido ni empezar.
//
// Devuelve { ok, problems: [...] }. No tira ni hace exit — quien llama decide.

const fs = require('fs');
const path = require('path');

const OAUTH_CREDENTIALS_PATH = path.join(__dirname, '..', 'oauth-credentials.json');
const TOKEN_PATH = path.join(__dirname, '..', 'token.json');

function checkApiKey() {
  if (!process.env.ANTHROPIC_API_KEY) {
    return 'Falta ANTHROPIC_API_KEY. Corré: setx ANTHROPIC_API_KEY <tu-key> y abrí una terminal nueva.';
  }
  return null;
}

function checkCredentials() {
  if (!fs.existsSync(OAUTH_CREDENTIALS_PATH) || !fs.existsSync(TOKEN_PATH)) {
    return 'Falta oauth-credentials.json o token.json en la carpeta del proyecto (los usa el registro en la hoja y la subida de screenshots). Corré: node auth.js';
  }
  return null;
}

function checkPlaywright() {
  try {
    require.resolve('playwright');
    return null;
  } catch {
    return 'Playwright no está instalado. Corré: npm install';
  }
}

function checkGoogleapis() {
  try {
    require.resolve('googleapis');
    return null;
  } catch {
    return 'googleapis no está instalado. Corré: npm install';
  }
}

const MIN_FREE_DISK_GB = 5;

// Espacio libre en el disco de `dirPath` (repo root por default), en GB.
// Devuelve null si fs.statfsSync no está disponible o falla (nunca lanza) —
// en ese caso el caller trata "no se pudo medir" como "no hay problema
// conocido" en vez de bloquear el pipeline por una limitación de la plataforma.
function getFreeDiskGB(dirPath = path.join(__dirname, '..')) {
  try {
    const stats = fs.statfsSync(dirPath);
    return (stats.bavail * stats.bsize) / (1024 ** 3);
  } catch {
    return null;
  }
}

// Whisper/demucs/MP3s/logs pueden llenar disco en una corrida larga de
// --loop de toda la noche — mejor frenar con un aviso claro ANTES de fallar
// a mitad de una descarga/transcripción con un error confuso de "no space
// left on device". Se llama en preflight (una vez) Y periódicamente durante
// --loop (ver start-flow.js) para cubrir todo lo que se llena DURANTE la
// noche, no solo al arrancar.
function checkDiskSpace({ minFreeGB = MIN_FREE_DISK_GB } = {}) {
  const freeGB = getFreeDiskGB();
  if (freeGB === null) return null; // no se pudo medir — no bloquear por eso
  if (freeGB < minFreeGB) {
    return `Poco espacio en disco: ${freeGB.toFixed(1)} GB libres (mínimo recomendado ${minFreeGB} GB). Whisper/demucs/MP3s pueden fallar a mitad de la noche.`;
  }
  return null;
}

function runPreflight({ log = console.log } = {}) {
  const problems = [
    checkApiKey(),
    checkCredentials(),
    checkPlaywright(),
    checkGoogleapis(),
    checkDiskSpace(),
  ].filter(Boolean);

  if (problems.length === 0) {
    log('✅ Preflight OK (API key, credenciales, dependencias).');
    return { ok: true, problems: [] };
  }

  log('❌ Preflight encontró problemas:');
  problems.forEach((p) => log(`   • ${p}`));
  return { ok: false, problems };
}

module.exports = { runPreflight, checkDiskSpace, getFreeDiskGB, MIN_FREE_DISK_GB };
