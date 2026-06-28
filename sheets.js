// sheets.js — Wrapper standalone. Mantiene el comando "node sheets.js" igual
// que siempre, pero ahora la lógica vive en lib/sheets-core.js para poder
// reutilizarla desde start-flow.js --done sin duplicarla.

const { logSongToSheet } = require('./lib/sheets-core');

(async () => {
  const result = await logSongToSheet();
  if (result.written) {
    console.log(`\n⏱️  Completá manualmente: Total Time, Time, Remarks y Screenshot.`);
  }
})().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
