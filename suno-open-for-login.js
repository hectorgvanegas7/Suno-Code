// Opens Chrome for a manual Suno login, ready to be picked up by suno-fill.js /
// suno-create.js over CDP afterwards.
//
// IMPORTANT: launches Chrome as a plain OS process (spawn), NOT via Playwright's
// launchPersistentContext. Playwright's automation flags (--enable-automation,
// --remote-debugging-pipe) make Google's OAuth flow show a "this browser may not
// be secure" block during login. A plain launch with a fixed --remote-debugging-port
// avoids that entirely while still being attachable via chromium.connectOverCDP().
// See LESSONS.md: "CDP lifecycle pattern".
const { spawn } = require('child_process');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER_DATA_DIR = 'C:\\Users\\hecto\\AppData\\Local\\ChromeAutomationProfile';
const PROFILE_DIRECTORY = 'Profile 1';
const DEBUG_PORT = 9333;

spawn(
  CHROME_PATH,
  [
    `--user-data-dir=${USER_DATA_DIR}`,
    `--profile-directory=${PROFILE_DIRECTORY}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    'https://suno.com/create',
  ],
  { detached: true, stdio: 'ignore' }
).unref();

console.log(`Chrome lanzado con debugging port ${DEBUG_PORT}. Iniciá sesión manualmente en la ventana.`);
console.log('Una vez logueado, suno-fill.js y suno-create.js pueden conectarse a esta misma ventana.');
