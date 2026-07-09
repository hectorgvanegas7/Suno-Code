// lib/audio-match.js — Encuentra los 2 MP3 de Suno que corresponden a la
// canción actual, comparando por título normalizado y timestamp reciente.
//
// Criterio de match: nombre de archivo contiene el título normalizado Y fue
// modificado en los últimos RECENCY_MINUTES minutos. Si hay exactamente 2,
// son Versión A y B (ordenados por fecha de creación, más antiguo = A).
// Si hay más de 2 o menos de 2, avisa y no analiza — mejor frenar que
// analizar la canción equivocada.

const os = require('os');
const fs = require('fs');
const path = require('path');

const SUNO_DIR = path.join(os.homedir(), 'Downloads', 'suno');
const RECENCY_MINUTES = 20;

// Normaliza texto para comparación: minúsculas, sin tildes, sin puntuación,
// sin espacios extra. Tolera diferencias de codificación en nombres de archivo.
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Calcula qué tan similar son dos strings normalizados: fracción de palabras
// del título que aparecen en el nombre del archivo. Ignora palabras de ≤2
// caracteres (demasiado genéricas para ser señal real) — PERO si un título
// está compuesto ENTERAMENTE por palabras cortas (ej. "Fe", "Ir", "A ti"),
// ese filtro dejaba `words` vacío y el score daba 0 siempre, sin importar el
// archivo: un título corto nunca podía matchear nada, aunque el MP3 correcto
// estuviera bien guardado en disco (bug real, ver LESSONS.md). Fallback: si
// el filtro deja la lista vacía, usar TODAS las palabras sin filtrar en vez
// de rendirse.
function titleMatchScore(normalizedTitle, normalizedFilename) {
  const allWords = normalizedTitle.split(' ').filter(Boolean);
  const words = allWords.filter((w) => w.length > 2);
  const effectiveWords = words.length > 0 ? words : allWords;
  if (!effectiveWords.length) return 0;
  const matched = effectiveWords.filter((w) => normalizedFilename.includes(w));
  return matched.length / effectiveWords.length;
}

// Devuelve los 2 MP3 que corresponden a esta canción.
// title: string con el título de la canción.
// options.recencyMinutes: cuántos minutos hacia atrás considerar (default 20).
// options.sunoDir: carpeta donde buscar (default Downloads/suno/).
// Lanza Error descriptivo si no puede identificar exactamente 2 archivos.
function findSunoMp3s(title, { recencyMinutes = RECENCY_MINUTES, sunoDir = SUNO_DIR } = {}) {
  if (!fs.existsSync(sunoDir)) {
    throw new Error(
      `Carpeta de descargas de Suno no encontrada: ${sunoDir}\n` +
      `Corrí setup-whisper.js o creá la carpeta manualmente.`
    );
  }

  const now = Date.now();
  const cutoff = now - recencyMinutes * 60 * 1000;
  const normalTitle = normalize(title);

  const allFiles = fs.readdirSync(sunoDir);
  const mp3Files = allFiles
    .filter((f) => f.toLowerCase().endsWith('.mp3'))
    .map((f) => {
      const fullPath = path.join(sunoDir, f);
      const stat = fs.statSync(fullPath);
      return { name: f, path: fullPath, mtime: stat.mtimeMs, size: stat.size };
    })
    .filter((f) => f.size > 0 && !f.name.endsWith('.crdownload'));

  // Filtrar por recencia
  const recent = mp3Files.filter((f) => f.mtime >= cutoff);

  // Filtrar por título (score >= 0.5 = más de la mitad de palabras presentes)
  const MIN_SCORE = 0.5;
  const matched = recent.filter((f) => {
    const score = titleMatchScore(normalTitle, normalize(f.name));
    return score >= MIN_SCORE;
  });

  // Ordenar por mtime (más antiguo = A, más nuevo = B)
  matched.sort((a, b) => a.mtime - b.mtime);

  if (matched.length === 0) {
    const recentNames = recent.map((f) => f.name).join(', ') || '(ninguno)';
    throw new Error(
      `No se encontraron MP3 que coincidan con el título "${title}" en los últimos ${recencyMinutes} min.\n` +
      `Archivos recientes en ${sunoDir}: ${recentNames}\n` +
      `Verificá que ya se descargaron los MP3 de Suno y que los nombres coincidan con el título.`
    );
  }

  if (matched.length === 1) {
    console.warn(
      `⚠️  Solo se encontró 1 MP3 que coincide con "${title}". Esperando 2 versiones.\n` +
      `   Archivo: ${matched[0].name}\n` +
      `   Si Suno generó solo 1, usá: node upload-to-flow.js --file "${matched[0].path}"`
    );
    return { versionA: matched[0], versionB: null };
  }

  if (matched.length > 2) {
    console.warn(
      `⚠️  Se encontraron ${matched.length} MP3 que podrían corresponder a "${title}" (últimos ${recencyMinutes} min).\n` +
      `   Tomando los 2 más recientes como A y B. Si no son los correctos, usá --file directamente.\n` +
      `   Archivos considerados: ${matched.map((f) => f.name).join(', ')}`
    );
    return { versionA: matched[matched.length - 2], versionB: matched[matched.length - 1] };
  }

  return { versionA: matched[0], versionB: matched[1] };
}

module.exports = { findSunoMp3s, normalize, titleMatchScore, SUNO_DIR };
