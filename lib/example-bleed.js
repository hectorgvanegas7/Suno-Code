// lib/example-bleed.js — Detector DETERMINÍSTICO de calcos del ejemplo dorado
// (2026-07-15).
//
// Motivación (visto en producción la misma noche en que se agregó el Golden
// Example al SYSTEM_PROMPT): la canción "Keyla" abrió el Bridge con "cuando
// ya no esté para decirlo de frente" — casi calco del Bridge del ejemplo
// ("Cuando ya no esté para decirlo con mi voz"). El prompt ya prohíbe copiar
// el ejemplo, pero una prohibición de prompt no es garantía (principio del
// repo). Esto lo vuelve mecánico y GENERAL: cualquier línea generada que
// comparta demasiado con cualquier línea del ejemplo dispara el mismo regen
// correctivo que un fallo de hardValidate.
//
// Criterios de calco (cualquiera de los dos):
//   a) n-grama de N_GRAM_SIZE+ palabras consecutivas compartido con una línea
//      del ejemplo — SALVO que ese n-grama aparezca en la ENCUESTA (si el
//      cliente lo dijo, es material legítimo de esta canción, no un calco;
//      ej. "le doy gracias a dios por" cuando la encuesta lo dice).
//   b) similitud de línea completa >= LINE_SIMILARITY_THRESHOLD (Jaccard de
//      palabras normalizadas) — agarra reescrituras con las mismas palabras
//      en otro orden.
//
// La fuente canónica del ejemplo es golden/2026-07-14-damian-buena/song.txt
// (el mismo archivo del banco dorado — si el ejemplo del prompt cambia de
// canción, actualizar EXAMPLE_SONG_PATH acá). Si el archivo no existe, el
// chequeo se desactiva en silencio (nunca rompe una generación por un
// problema de disco). 100% puro y offline. Tests: test/example-bleed.test.js

const fs = require('fs');
const path = require('path');

const EXAMPLE_SONG_PATH = path.join(__dirname, '..', 'golden', '2026-07-14-damian-buena', 'song.txt');
const N_GRAM_SIZE = 5;
const LINE_SIMILARITY_THRESHOLD = 0.8;
const MIN_WORDS_FOR_LINE_CHECK = 4;

function normalizeWords(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zñ\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function nGrams(words, n) {
  const grams = [];
  for (let i = 0; i + n <= words.length; i++) {
    grams.push(words.slice(i, i + n).join(' '));
  }
  return grams;
}

// Jaccard de conjuntos de palabras — agarra "mismas palabras, otro orden".
function lineSimilarity(a, b) {
  const setA = new Set(normalizeWords(a));
  const setB = new Set(normalizeWords(b));
  if (!setA.size || !setB.size) return 0;
  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared++;
  return shared / (setA.size + setB.size - shared);
}

// Extrae las líneas cantables del song.txt del ejemplo ([Verse 1]..[Outro]).
function parseExampleLines(songTxtContent) {
  const lines = [];
  const re = /\[(Verse 1|Chorus 1|Verse 2|Chorus 2|Bridge|Outro)\]\n([\s\S]*?)(?=\n\[|\n---|\n\*\*|$)/g;
  let m;
  while ((m = re.exec(songTxtContent)) !== null) {
    for (const line of m[2].split('\n')) {
      const t = line.trim();
      if (t) lines.push(t);
    }
  }
  return lines;
}

let cachedExampleLines = null;
function getExampleLines() {
  if (cachedExampleLines) return cachedExampleLines;
  try {
    cachedExampleLines = parseExampleLines(fs.readFileSync(EXAMPLE_SONG_PATH, 'utf-8'));
  } catch {
    cachedExampleLines = []; // sin ejemplo en disco → chequeo desactivado
  }
  return cachedExampleLines;
}

// Chequea una canción generada ({ 'Verse 1': [...], ... }) contra las líneas
// del ejemplo. surveyText permite eximir n-gramas que la propia encuesta
// contiene. exampleLines inyectable para tests. Devuelve una lista de
// hallazgos [{ seccion, linea (1-idx), texto, ejemplo, motivo }].
function findExampleBleed(letras, surveyText = '', { exampleLines = null } = {}) {
  const examples = exampleLines || getExampleLines();
  if (!examples.length) return [];
  const surveyGrams = new Set(nGrams(normalizeWords(surveyText), N_GRAM_SIZE));
  const exampleData = examples.map((line) => ({
    line,
    words: normalizeWords(line),
    grams: new Set(nGrams(normalizeWords(line), N_GRAM_SIZE)),
  }));

  const findings = [];
  for (const [seccion, lines] of Object.entries(letras || {})) {
    if (!Array.isArray(lines)) continue;
    lines.forEach((texto, i) => {
      const words = normalizeWords(texto);
      const grams = nGrams(words, N_GRAM_SIZE);
      for (const ex of exampleData) {
        const sharedGram = grams.find((g) => ex.grams.has(g) && !surveyGrams.has(g));
        if (sharedGram) {
          findings.push({
            seccion,
            linea: i + 1,
            texto,
            ejemplo: ex.line,
            motivo: `comparte ${N_GRAM_SIZE}+ palabras consecutivas con el ejemplo ("${sharedGram}") y la encuesta no las contiene`,
          });
          return; // una línea calcada se reporta una sola vez
        }
        if (words.length >= MIN_WORDS_FOR_LINE_CHECK && lineSimilarity(texto, ex.line) >= LINE_SIMILARITY_THRESHOLD) {
          findings.push({
            seccion,
            linea: i + 1,
            texto,
            ejemplo: ex.line,
            motivo: `es casi la misma línea del ejemplo (similitud ${Math.round(lineSimilarity(texto, ex.line) * 100)}%)`,
          });
          return;
        }
      }
    });
  }
  return findings;
}

module.exports = { findExampleBleed, parseExampleLines, lineSimilarity, normalizeWords, nGrams, EXAMPLE_SONG_PATH, N_GRAM_SIZE, LINE_SIMILARITY_THRESHOLD };
