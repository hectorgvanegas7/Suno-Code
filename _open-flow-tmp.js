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
    'https://cancioneterna.com/artists/flow',
  ],
  { detached: true, stdio: 'ignore' }
).unref();

console.log(`Chrome lanzado con debugging port ${DEBUG_PORT} en la pagina del Flow.`);
