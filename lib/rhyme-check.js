// lib/rhyme-check.js — Análisis DETERMINÍSTICO de rima en español (2026-07-14).
//
// Motivación (datos reales de logs/guardia-feedback.jsonl): el Guardia
// puntúa rima=7/10 una y otra vez con pares débiles concretos
// ("historia"/"ser", "trabajo"/"fuerza", "pase"/"cada día") mientras el
// modelo generador se auto-marca `rima_fuerte_evidente: true`. Misma lección
// que el caso "Miami": la autoevaluación del LLM no es garantía — pero la
// rima en español ES verificable mecánicamente:
//   - rima CONSONANTE: coincide todo desde la vocal acentuada ("corazón"/"razón").
//   - rima ASONANTE: coinciden solo las vocales desde la acentuada
//     ("cocina"/"vida" → i-a / i-a ✅; "historia"/"ser" → o-i-a / e ❌).
//
// SEÑAL INFORMATIVA (protocolo estándar del repo): consola + state.json +
// guardia-feedback.jsonl hasta calibrar contra REDOs/QA humano. La
// silabificación es una aproximación razonable (diptongos, hiatos por tilde,
// u muda en que/qui/gue/gui) — suficiente para detectar "estas dos palabras
// no riman ni de cerca", que es lo que el generador deja pasar.
//
// 100% puro y offline — sin LLM, sin red. Tests: test/rhyme-check.test.js

const STRONG = new Set(['a', 'e', 'o']);
const WEAK = new Set(['i', 'u']);
const ACCENT_MAP = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u' };

// Última palabra "cantable" de una línea (sin puntuación).
function lastWordOfLine(line) {
  const words = String(line || '')
    .toLowerCase()
    .replace(/[^a-záéíóúüñ\s]/gi, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.length ? words[words.length - 1] : null;
}

// Núcleos vocálicos de una palabra, en orden. Cada núcleo: { vowels: 'ia',
// accented: bool, start: índice del primer char del núcleo en la palabra }.
// Aproximación: vocales consecutivas forman un núcleo (diptongo) SALVO hiato
// (dos fuertes seguidas, o débil acentuada junto a otra vocal). La u de
// "que/qui/gue/gui" es muda.
function vowelNuclei(word) {
  const w = String(word || '').toLowerCase();
  const chars = [];
  for (let i = 0; i < w.length; i++) {
    let c = w[i];
    const accented = c in ACCENT_MAP;
    if (accented) c = ACCENT_MAP[c];
    if (c === 'ü') c = 'u';
    const isVowel = 'aeiou'.includes(c);
    if (!isVowel) { chars.push({ c, vowel: false, idx: i }); continue; }
    // u muda en que/qui/gue/gui (la ü ya se trató como sonora arriba)
    if (c === 'u' && w[i] !== 'ü' && i > 0 && (w[i - 1] === 'q' || w[i - 1] === 'g')) {
      const next = w[i + 1] ? (ACCENT_MAP[w[i + 1]] || w[i + 1]) : '';
      if (next === 'e' || next === 'i') { chars.push({ c, vowel: false, idx: i }); continue; }
    }
    chars.push({ c, vowel: true, accented, idx: i });
  }

  const nuclei = [];
  let current = null;
  let prev = null;
  for (const ch of chars) {
    if (!ch.vowel) { current = null; prev = null; continue; }
    const breaksDiphthong =
      current &&
      prev &&
      // dos fuertes seguidas = hiato (le-al, po-e-ta)
      ((STRONG.has(prev.c) && STRONG.has(ch.c)) ||
        // débil ACENTUADA junto a otra vocal = hiato (dí-a, ba-úl)
        (WEAK.has(ch.c) && ch.accented) ||
        (WEAK.has(prev.c) && prev.accented));
    if (!current || breaksDiphthong) {
      current = { vowels: ch.c, accented: !!ch.accented, start: ch.idx };
      nuclei.push(current);
    } else {
      current.vowels += ch.c;
      if (ch.accented) current.accented = true;
    }
    prev = ch;
  }
  return nuclei;
}

// Índice del núcleo tónico. Tilde explícita gana; si no: aguda si termina en
// consonante (≠ n/s), grave si termina en vocal/n/s.
function stressedNucleusIndex(word, nuclei) {
  if (!nuclei.length) return -1;
  const explicit = nuclei.findIndex((n) => n.accented);
  if (explicit !== -1) return explicit;
  const w = String(word || '').toLowerCase().replace(/[^a-záéíóúüñ]/g, '');
  const last = w[w.length - 1] || '';
  const endsGrave = 'aeiouáéíóúns'.includes(last);
  if (endsGrave && nuclei.length >= 2) return nuclei.length - 2;
  return nuclei.length - 1;
}

// Vocal representativa de un núcleo para asonancia: la fuerte del diptongo
// ("ue" → e, "ia" → a); si es débil sola, la débil.
function nucleusKeyVowel(nucleus) {
  const strong = [...nucleus.vowels].find((v) => STRONG.has(v));
  return strong || nucleus.vowels[nucleus.vowels.length - 1];
}

// Clave de rima de una palabra: { asonante: 'i-a', consonante: 'ida' } desde
// la vocal tónica hasta el final. null si no hay vocales.
function rhymeKey(word) {
  const clean = String(word || '').toLowerCase().replace(/[^a-záéíóúüñ]/g, '');
  if (!clean) return null;
  const nuclei = vowelNuclei(clean);
  const idx = stressedNucleusIndex(clean, nuclei);
  if (idx === -1) return null;
  const asonante = nuclei.slice(idx).map(nucleusKeyVowel).join('-');
  // Consonante: el sufijo textual desde el primer char del núcleo tónico
  // (los núcleos ya traen su posición), sin tildes.
  const deaccented = [...clean].map((c) => ACCENT_MAP[c] || c).join('');
  const consonante = deaccented.slice(nuclei[idx].start);
  return { asonante, consonante };
}

// ¿Riman dos palabras? → 'consonante' | 'asonante' | null.
// Una palabra idéntica a sí misma no cuenta como rima (repetir la palabra no
// es rimar).
function wordsRhyme(a, b) {
  const ka = rhymeKey(a);
  const kb = rhymeKey(b);
  if (!ka || !kb) return null;
  const cleanA = String(a).toLowerCase().replace(/[^a-záéíóúüñ]/g, '');
  const cleanB = String(b).toLowerCase().replace(/[^a-záéíóúüñ]/g, '');
  if (cleanA === cleanB) return null;
  if (ka.consonante === kb.consonante && ka.consonante.length > 1) return 'consonante';
  if (ka.asonante === kb.asonante) return 'asonante';
  return null;
}

// Esquemas posibles para una sección de 4 líneas.
const SCHEMES = {
  AABB: [[0, 1], [2, 3]],
  ABAB: [[0, 2], [1, 3]],
  ABBA: [[0, 3], [1, 2]],
};

// Analiza una sección (array de líneas): elige el esquema con más pares que
// riman y reporta los pares débiles del mejor esquema.
function analyzeSectionRhyme(lines) {
  const words = (lines || []).map(lastWordOfLine);
  let best = { scheme: null, rhymingPairs: 0, totalPairs: 0, weakPairs: [] };
  for (const [scheme, pairs] of Object.entries(SCHEMES)) {
    const applicable = pairs.filter(([i, j]) => words[i] && words[j]);
    if (!applicable.length) continue;
    const results = applicable.map(([i, j]) => ({ i, j, a: words[i], b: words[j], tipo: wordsRhyme(words[i], words[j]) }));
    const rhyming = results.filter((r) => r.tipo).length;
    if (!best.scheme || rhyming > best.rhymingPairs) {
      best = {
        scheme,
        rhymingPairs: rhyming,
        totalPairs: applicable.length,
        weakPairs: results.filter((r) => !r.tipo).map((r) => `"${r.a}"/"${r.b}"`),
      };
    }
  }
  return best;
}

// Analiza la canción entera ({ 'Verse 1': [...], ... }).
// Devuelve { secciones: {nombre: analisis}, sinRima: [nombres], parciales: [nombres], resumen }.
function analyzeSongRhyme(letras) {
  const secciones = {};
  const sinRima = [];
  const parciales = [];
  for (const [name, lines] of Object.entries(letras || {})) {
    if (!Array.isArray(lines) || lines.length === 0) continue;
    const analisis = analyzeSectionRhyme(lines);
    secciones[name] = analisis;
    if (analisis.totalPairs > 0 && analisis.rhymingPairs === 0) sinRima.push(name);
    else if (analisis.rhymingPairs < analisis.totalPairs) parciales.push(name);
  }
  const resumen = sinRima.length
    ? `⚠️ ${sinRima.length} sección(es) SIN ningún par que rime (${sinRima.join(', ')})`
    : parciales.length
      ? `Parcial: ${parciales.length} sección(es) con pares débiles (${parciales.join(', ')})`
      : '✅ Todas las secciones riman (consonante o asonante) en algún esquema';
  return { secciones, sinRima, parciales, resumen };
}

module.exports = { lastWordOfLine, vowelNuclei, stressedNucleusIndex, rhymeKey, wordsRhyme, analyzeSectionRhyme, analyzeSongRhyme, SCHEMES };
