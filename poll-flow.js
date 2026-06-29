// DEPRECADO — La lógica del poller ahora vive en start-flow.js.
// Este archivo redirige para compatibilidad hacia atrás.
//
//   Antes:  node poll-flow.js [intervalo]
//   Ahora:  node start-flow.js --poll [intervalo]
//
// Ambos comandos son equivalentes.
const { spawn } = require('child_process');
const args = process.argv.slice(2); // preserva el intervalo si lo pasaron
spawn('node', ['start-flow.js', '--poll', ...args], { cwd: __dirname, stdio: 'inherit' })
  .on('exit', (code) => process.exit(code ?? 0));
