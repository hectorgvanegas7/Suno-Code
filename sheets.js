// sheets.js — Wrapper standalone. Mantiene el comando "node sheets.js" igual
// que siempre, pero ahora la lógica vive en lib/sheets-core.js para poder
// reutilizarla desde start-flow.js --done sin duplicarla.

const { logSongToSheet } = require('./lib/sheets-core');

(async () => {
  const result = await logSongToSheet();
  if (result.written) {
    const pipelineState = require('./lib/pipeline-state');
    const state = pipelineState.read();
    const currentRemark = require('./lib/sheets-core').buildAutoRemark(state && state.isRedo);
    const pending = ['Total Time', 'Time'];
    if (!currentRemark) pending.push('Remarks');
    pending.push('Screenshot');
    console.log(`\n⏱️  Completá manualmente: ${pending.join(', ')}.`);
  }
})().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
