// lib/hygiene.js — Limpieza automática de logs/ y screenshots/ viejos.
//
// logs/ y screenshots/ (ver .gitignore) crecen sin límite: cada corrida deja
// un logs/run-*.log + logs/verify-audio-auto-*.log, y cada verificación visual
// deja PNGs sueltos en la raíz + una copia recortada en screenshots/. Nadie
// los borra nunca. Rotación simple: al final de cada corrida exitosa,
// cualquier archivo más viejo que RETENTION_DAYS se borra.
//
// Deliberadamente best-effort: nunca lanza, nunca bloquea start-flow.js —
// un fallo acá (permisos, disco) no debe frenar el cierre de una canción.

const fs = require('fs');
const path = require('path');

const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

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

// Rota logs/ y screenshots/ del repo. Nunca lanza — cualquier error queda en
// el resultado, no interrumpe al caller.
function rotateOldRunFiles({ repoRoot = path.join(__dirname, '..'), now = Date.now() } = {}) {
  const targets = {
    logs: cleanOldFiles(path.join(repoRoot, 'logs'), { now }),
    screenshots: cleanOldFiles(path.join(repoRoot, 'screenshots'), { now }),
  };
  const totalDeleted = targets.logs.deleted.length + targets.screenshots.deleted.length;
  if (totalDeleted > 0) {
    console.log(`🧹 Higiene: borrados ${totalDeleted} archivo(s) de más de ${RETENTION_DAYS} días (logs/ + screenshots/).`);
  }
  const allErrors = [...targets.logs.errors, ...targets.screenshots.errors];
  if (allErrors.length > 0) {
    console.warn(`⚠️  Higiene: ${allErrors.length} archivo(s) no se pudieron limpiar (no crítico).`);
  }
  return targets;
}

module.exports = { cleanOldFiles, rotateOldRunFiles, RETENTION_DAYS };
