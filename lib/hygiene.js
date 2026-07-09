// lib/hygiene.js — Limpieza automática de logs/ y screenshots/ viejos.
//
// logs/ y screenshots/ (ver .gitignore) crecen sin límite: cada corrida deja
// un logs/run-*.log + logs/verify-audio-auto-*.log, y cada verificación visual
// deja PNGs sueltos en la raíz + una copia recortada en screenshots/. Nadie
// los borra nunca. Rotación simple: al final de cada corrida exitosa,
// cualquier archivo más viejo que RETENTION_DAYS se borra.
//
// Los logs .jsonl append-only (auto-submit-events, phonetic-candidates,
// pacing-feedback — ver start-flow.js/run.js/verify-audio.js) NO entran en
// esa rotación por mtime: cada línea nueva actualiza el mtime del archivo
// entero, así que mientras el pipeline siga corriendo regularmente estos
// archivos nunca envejecen lo suficiente para borrarse — crecerían para
// siempre (bug real, detectado 2026-07-08). Se rotan aparte, por CANTIDAD
// de líneas (trimGrowingJsonlFiles), no por edad.
//
// Deliberadamente best-effort: nunca lanza, nunca bloquea start-flow.js —
// un fallo acá (permisos, disco) no debe frenar el cierre de una canción.

const fs = require('fs');
const path = require('path');

const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const MAX_JSONL_LINES = 5000;

// Borra archivos de `dirPath` (no subcarpetas) con mtime más viejo que
// RETENTION_DAYS respecto a `now`. Devuelve { deleted: [...nombres], errors: [...] }.
// `now` es parametrizable para poder testear sin depender de Date.now() real.
function cleanOldFiles(dirPath, { now = Date.now(), retentionMs = RETENTION_MS } = {}) {
  const result = { deleted: [], errors: [] };
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (e) {
    result.errors.push(`No se pudo leer ${dirPath}: ${e.message}`);
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(dirPath, entry.name);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > retentionMs) {
        fs.unlinkSync(filePath);
        result.deleted.push(entry.name);
      }
    } catch (e) {
      result.errors.push(`${entry.name}: ${e.message}`);
    }
  }
  return result;
}

// Recorta cualquier *.jsonl de `dirPath` a sus últimas `maxLines` líneas si
// las excede — escritura atómica (tmp + rename), mismo patrón que
// lib/pipeline-state.js. Devuelve { trimmed: [{name, from, to}], errors: [] }.
function trimGrowingJsonlFiles(dirPath, { maxLines = MAX_JSONL_LINES } = {}) {
  const result = { trimmed: [], errors: [] };
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (e) {
    result.errors.push(`No se pudo leer ${dirPath}: ${e.message}`);
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const filePath = path.join(dirPath, entry.name);
    try {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter((l) => l.length > 0);
      if (lines.length <= maxLines) continue;
      const kept = lines.slice(-maxLines);
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, kept.join('\n') + '\n', 'utf-8');
      fs.renameSync(tmpPath, filePath);
      result.trimmed.push({ name: entry.name, from: lines.length, to: kept.length });
    } catch (e) {
      result.errors.push(`${entry.name}: ${e.message}`);
    }
  }
  return result;
}

// Rota logs/ y screenshots/ del repo, más los clips de confirmación de oído
// que verify-audio deja en Downloads/suno/ (name-check/ y truncated-words/ —
// crecían sin rotación, auditoría 2026-07-09). Nunca lanza — cualquier error
// queda en el resultado, no interrumpe al caller.
function rotateOldRunFiles({ repoRoot = path.join(__dirname, '..'), now = Date.now() } = {}) {
  const { SUNO_DIR } = require('./audio-match');
  const emptyResult = { deleted: [], errors: [] };
  const cleanIfExists = (dir) => (fs.existsSync(dir) ? cleanOldFiles(dir, { now }) : emptyResult);

  const targets = {
    logs: cleanOldFiles(path.join(repoRoot, 'logs'), { now }),
    screenshots: cleanOldFiles(path.join(repoRoot, 'screenshots'), { now }),
    nameCheckClips: cleanIfExists(path.join(SUNO_DIR, 'name-check')),
    truncatedClips: cleanIfExists(path.join(SUNO_DIR, 'truncated-words')),
    jsonlTrim: trimGrowingJsonlFiles(path.join(repoRoot, 'logs')),
  };
  const totalDeleted = targets.logs.deleted.length + targets.screenshots.deleted.length
    + targets.nameCheckClips.deleted.length + targets.truncatedClips.deleted.length;
  if (totalDeleted > 0) {
    console.log(`🧹 Higiene: borrados ${totalDeleted} archivo(s) de más de ${RETENTION_DAYS} días (logs/, screenshots/, clips de audio).`);
  }
  if (targets.jsonlTrim.trimmed.length > 0) {
    for (const t of targets.jsonlTrim.trimmed) {
      console.log(`🧹 Higiene: ${t.name} recortado de ${t.from} a ${t.to} líneas.`);
    }
  }
  const allErrors = [...targets.logs.errors, ...targets.screenshots.errors, ...targets.nameCheckClips.errors, ...targets.truncatedClips.errors, ...targets.jsonlTrim.errors];
  if (allErrors.length > 0) {
    console.warn(`⚠️  Higiene: ${allErrors.length} archivo(s) no se pudieron limpiar (no crítico).`);
  }
  return targets;
}

module.exports = { cleanOldFiles, trimGrowingJsonlFiles, rotateOldRunFiles, RETENTION_DAYS, MAX_JSONL_LINES };
