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

function writeCache(hash, content) {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  const cachePath = path.join(CACHE_DIR, `${hash}.json`);
  try {
    fs.writeFileSync(cachePath, JSON.stringify(content, null, 2), 'utf-8');
  } catch (e) {
    console.warn(`[Caché] Error guardando caché para ${hash}: ${e.message}`);
  }
}

module.exports = {
  getSurveyHash,
  readCache,
  writeCache
};
