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

// ── Puerto CDP (idea de IDEAS.md, cableada 2026-07-14) ───────────────────────
// Tres estados posibles del puerto de debug de Chrome:
//   1. Responde a /json/version → Chrome debug listo (OK).
//   2. Libre → OK, start-flow lanza Chrome más adelante.
//   3. Ocupado pero NO responde como Chrome debug → problema: otro proceso
//      (u otro Chrome sin --remote-debugging-port) tiene el puerto, y la
//      automatización va a fallar recién a mitad del flujo con un error
//      confuso. Mejor avisar acá, con instrucción clara.
// `fetchImpl`/`connectImpl` inyectables para testear offline.
async function checkCdpPort(port = 9333, { fetchImpl = fetch, connectImpl = null } = {}) {
  try {
    const res = await fetchImpl(`http://localhost:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) return null; // Chrome debug listo
  } catch {
    // no responde como Chrome debug — chequear si el TCP está ocupado igual
  }

  const isOccupied = connectImpl
    ? await connectImpl(port)
    : await new Promise((resolve) => {
        const net = require('net');
        const socket = net.connect({ port, host: '127.0.0.1' });
        socket.setTimeout(1500);
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => resolve(false));
        socket.once('timeout', () => { socket.destroy(); resolve(false); });
      });

  if (isOccupied) {
    return (
      `El puerto ${port} está ocupado por algo que NO responde como Chrome en modo debug ` +
      '(¿un Chrome abierto a mano sin --remote-debugging-port, u otro proceso?). ' +
      'La automatización va a fallar al conectar. Cerrá ese proceso o corré: node suno-open-for-login.js'
    );
  }
  return null; // libre — start-flow lanza Chrome cuando haga falta
}

// ── LanguageTool (Capa 2 de QA de letra) ─────────────────────────────────────
// Si el servicio está caído, runGrammarGate degrada la corrida entera en
// silencio (bug de visibilidad detectado en la auditoría 2026-07-14) — esto
// lo convierte en un WARNING visible al arrancar (no bloquea: es outage de
// red, no de contenido — mismo criterio que run.js).
async function checkLanguageTool({ fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl('https://api.languagetool.org/v2/languages', { signal: AbortSignal.timeout(3000) });
    if (res.ok) return null;
    return `LanguageTool respondió ${res.status} — la Capa 2 de QA de letra va a degradar (se entrega con advertencia de revisión manual).`;
  } catch (e) {
    return `LanguageTool no responde (${String(e && e.message).slice(0, 60)}) — la Capa 2 de QA de letra va a degradar (se entrega con advertencia de revisión manual).`;
  }
}

// ── Smoke test de API real (lección "migración Haiku rota desde el día 1",
// LESSONS.md 2026-07-14) ──────────────────────────────────────────────────────
// Los 300+ tests offline con mocks NUNCA validan que la llamada real a la API
// sea válida (schema, key vigente, saldo). UNA llamada mínima real a Haiku
// (unas decenas de tokens, fracción de centavo) antes de arrancar la noche
// atrapa esa clase de rotura a las 22:00 en vez de a las 3 AM. Se corre solo
// con --with-api (nunca en el preflight normal — cuesta plata real).
async function checkAnthropicApi({ fetchImpl = fetch } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return 'ANTHROPIC_API_KEY no está configurada — el smoke de API no se puede correr.';
  }
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 16,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: 'Respondé exactamente: OK' }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      return `Smoke de API real falló: Anthropic respondió ${res.status} — ${(await res.text()).slice(0, 200)}`;
    }
    const data = await res.json();
    const text = (data.content || []).map((b) => b.text || '').join('').trim();
    if (!text) return 'Smoke de API real: la respuesta llegó sin texto — revisar antes de confiar en la noche.';
    return null;
  } catch (e) {
    return `Smoke de API real falló: ${String(e && e.message).slice(0, 120)}`;
  }
}

// runPreflight es async desde 2026-07-14 (chequeo de puerto CDP + LanguageTool).
// Devuelve { ok, problems, warnings }: problems bloquean, warnings solo avisan.
async function runPreflight({ log = console.log } = {}) {
  const problems = [
    checkApiKey(),
    checkCredentials(),
    checkPlaywright(),
    checkGoogleapis(),
    checkDiskSpace(),
    await checkCdpPort(),
  ].filter(Boolean);

  const warnings = [await checkLanguageTool()].filter(Boolean);

  if (warnings.length > 0) {
    log('⚠️ Preflight — advertencias (no bloquean):');
    warnings.forEach((w) => log(`   • ${w}`));
  }

  if (problems.length === 0) {
    log('✅ Preflight OK (API key, credenciales, dependencias, puerto CDP, disco).');
    return { ok: true, problems: [], warnings };
  }

  log('❌ Preflight encontró problemas:');
  problems.forEach((p) => log(`   • ${p}`));
  return { ok: false, problems, warnings };
}

module.exports = { runPreflight, checkDiskSpace, getFreeDiskGB, MIN_FREE_DISK_GB, checkCdpPort, checkLanguageTool, checkAnthropicApi };

// CLI: node lib/preflight.js [--with-api]
//   Sin flags: el preflight estándar (gratis). Con --with-api suma UNA llamada
//   real mínima a Haiku (fracción de centavo). Exit 1 si algo bloquea.
if (require.main === module) {
  (async () => {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
    // process.exit() en el mismo tick que el cierre del socket de fetch
    // crashea libuv en Windows ("Assertion failed: !(handle->flags &
    // UV_HANDLE_CLOSING)") — mismo patrón exitAfterDelay que run.js y
    // upload-to-flow.js.
    const exitAfterDelay = (code) => setTimeout(() => process.exit(code), 250);
    const result = await runPreflight();
    if (process.argv.includes('--with-api')) {
      const apiProblem = await checkAnthropicApi();
      if (apiProblem) {
        console.log(`❌ ${apiProblem}`);
        return exitAfterDelay(1);
      }
      console.log('✅ Smoke de API real OK (Haiku respondió).');
    }
    exitAfterDelay(result.ok ? 0 : 1);
  })();
}
