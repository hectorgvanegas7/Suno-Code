const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.join(__dirname, '..', '.cache');

function getSurveyHash(surveyText) {
  return crypto.createHash('md5').update(surveyText).digest('hex');
}

function readCache(hash) {
  const cachePath = path.join(CACHE_DIR, `${hash}.json`);
  if (fs.existsSync(cachePath)) {
    try {
      const data = fs.readFileSync(cachePath, 'utf-8');
      return JSON.parse(data);
    } catch (e) {
      console.warn(`[Caché] Error leyendo caché para ${hash}: ${e.message}`);
    }
  }
  return null;
}

// Escritura atómica (tmp + rename), mismo patrón que lib/pipeline-state.js
// (aplicado ahí después de un bug real de corrupción — ver LESSONS.md,
// "state.json: escritura atómica"). Un crash a mitad de un writeFileSync
// directo dejaba el JSON truncado; readCache ya lo tolera (JSON.parse falla
// → cache miss, se regenera), pero es la misma clase de riesgo y el fix es
// igual de barato acá.
function writeCache(hash, content) {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  const cachePath = path.join(CACHE_DIR, `${hash}.json`);
  const tmpPath = `${cachePath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(content, null, 2), 'utf-8');
    fs.renameSync(tmpPath, cachePath);
  } catch (e) {
    console.warn(`[Caché] Error guardando caché para ${hash}: ${e.message}`);
  }
}

// Borra la caché de una encuesta (2026-07-15, ver LESSONS.md "El Guardia
// rechazó y el loop sirvió la MISMA letra desde caché"). El bug real: la
// caché se escribe apenas hardValidate+LanguageTool+FACT_GATE pasan — ANTES
// de que corra El Guardia — así que si el Guardia rechaza por mayoría, esa
// letra rechazada queda cacheada igual. La siguiente corrida (retry del
// --loop, --resume, o simplemente correr run.js de nuevo sobre la misma
// encuesta) la servía de la caché sin volver a generar, repitiendo el mismo
// rechazo para siempre hasta que alguien la editara a mano o corriera
// --force-regen. run.js llama esto apenas el Guardia confirma el rechazo
// (después de que el reprompt de Haiku ya tuvo su oportunidad de arreglarla)
// para que la PRÓXIMA corrida esté forzada a generar de cero. Best-effort:
// nunca lanza, un fallo acá no debe frenar el pipeline.
function invalidateCache(hash) {
  const cachePath = path.join(CACHE_DIR, `${hash}.json`);
  try {
    if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
  } catch (e) {
    console.warn(`[Caché] Error invalidando caché para ${hash}: ${e.message}`);
  }
}

module.exports = {
  getSurveyHash,
  readCache,
  writeCache,
  invalidateCache
};
