// lib/preflight.js — Chequeo rápido antes de arrancar el flujo, para fallar
// temprano y claro en vez de a la mitad de una canción.
//
// Verifica lo barato y lo que más rompe:
//   1. ANTHROPIC_API_KEY presente.
//   2. google-credentials.json presente (lo necesita el registro en la hoja).
//   3. Playwright instalado (node_modules ok).
//
// NO verifica Chrome/Suno acá — eso lo maneja start-flow más adelante con su
// propio flujo de login (lanza la ventana y espera). El preflight es sólo para
// cosas que, si faltan, no tiene sentido ni empezar.
//
// Devuelve { ok, problems: [...] }. No tira ni hace exit — quien llama decide.

const fs = require('fs');
const path = require('path');

const CREDENTIALS_PATH = path.join(__dirname, '..', 'google-credentials.json');

function checkApiKey() {
  if (!process.env.ANTHROPIC_API_KEY) {
    return 'Falta ANTHROPIC_API_KEY. Corré: setx ANTHROPIC_API_KEY <tu-key> y abrí una terminal nueva.';
  }
  return null;
}

function checkCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    return 'Falta google-credentials.json en la carpeta del proyecto (lo usa el registro en la hoja).';
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

function runPreflight({ log = console.log } = {}) {
  const problems = [
    checkApiKey(),
    checkCredentials(),
    checkPlaywright(),
    checkGoogleapis(),
  ].filter(Boolean);

  if (problems.length === 0) {
    log('✅ Preflight OK (API key, credenciales, dependencias).');
    return { ok: true, problems: [] };
  }

  log('❌ Preflight encontró problemas:');
  problems.forEach((p) => log(`   • ${p}`));
  return { ok: false, problems };
}

module.exports = { runPreflight };
