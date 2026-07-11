// lib/spanish-spellcheck.js — detección GENERAL de tildes/eñes faltantes en
// palabras españolas comunes (no nombres propios — eso ya lo cubre
// STANDARD_SPANISH_NAMES en lib/song-validate.js).
//
// Motivación (ver LESSONS.md 2026-07-11, "Fogata en la Arena"): una lista
// fija de pares conocidos ("ano"->"año", "pequena"->"pequeña") solo atrapa
// los casos ya vistos — cualquier palabra nueva sin tilde/eñe se cuela igual
// la próxima vez. Esto usa un diccionario real de español (hunspell, vía
// nspell + dictionary-es) para chequear CUALQUIER palabra de la letra, no
// solo una lista curada.
//
// Estrategia (evita falsos positivos con palabras que legítimamente existen
// en ambas formas, ej. "mas"/"más", "solo"/"sólo", "aun"/"aún"):
//   1. Si la palabra YA es válida en el diccionario tal cual está escrita
//      (con o sin tilde), se deja pasar — no se toca. Esto cubre el caso
//      "mas" (conjunción, válida sin tilde) sin falsos positivos.
//   2. Si la palabra NO es válida como está, se generan variantes agregando
//      tilde/eñe en una o dos posiciones (a→á, e→é, i→í, o→ó, u→ú, n→ñ). Si
//      ALGUNA variante SÍ es válida en el diccionario, la palabra original
//      se marca como probable error de tilde/eñe, sugiriendo esa variante.
//   3. Además, un diccionario chico de EXCEPCIONES CONOCIDAS
//      (ENYE_TYPOS_BLOCKLIST) fuerza el chequeo aunque la palabra sin
//      tilde/eñe TAMBIÉN sea una palabra real distinta (ej. "ano" es una
//      palabra válida en sí misma — "año" sin eñe — así que el paso 1 la
//      dejaría pasar sin este blocklist explícito).
//
// Grado de confianza: nunca decide sola cuando la palabra sin acentuar no
// tiene NINGUNA variante acentuada válida (nombres propios, respellings
// fonéticos, palabras inventadas) — en ese caso no se marca nada, mismo
// criterio conservador que el resto de song-validate.js (ver isSafeToPatch).

const fs = require('fs');
const path = require('path');

let _spell = null;
function getSpellChecker() {
  if (_spell) return _spell;
  const nspell = require('nspell');
  const dictDir = path.join(__dirname, '..', 'node_modules', 'dictionary-es');
  const aff = fs.readFileSync(path.join(dictDir, 'index.aff'));
  const dic = fs.readFileSync(path.join(dictDir, 'index.dic'));
  _spell = nspell(aff, dic);
  return _spell;
}

// Palabras reales por sí solas (pasan el diccionario tal cual, por eso el
// paso 1 de arriba las dejaría pasar sin esto) pero que en este negocio
// (canciones dedicadas, temática familiar/fe) casi siempre son en realidad
// la versión CON tilde/eñe mal escrita — la ambigüedad se resuelve a favor
// de marcar, porque el costo de un falso positivo (el corrector barato
// revisa una línea) es mucho menor que el de un "ano" real llegando a QA
// (ver LESSONS.md 2026-07-11). Confirmadas contra el diccionario real
// (node_modules/dictionary-es) — no exhaustiva, incluye las de mayor
// frecuencia/riesgo para este negocio; sumar más acá si aparece un caso
// real nuevo, mismo criterio que KNOWN_INCOHERENT en song-validate.js.
const ENYE_TYPOS_BLOCKLIST = {
  ano: 'año', anos: 'años', // año/años — el caso real que originó este archivo
  sueno: 'sueño', suenos: 'sueños', // sueño(s) — también "yo sueno" (sonar), pero rarísimo en esta letra
  montana: 'montaña', montanas: 'montañas',
  papa: 'papá', papas: 'papás', // papá — "papa" también es papa/Papa, pero en dedicatorias casi siempre es papá
  mama: 'mamá', mamas: 'mamás',
  jamas: 'jamás',
  ademas: 'además',
  ultimo: 'último', ultima: 'última',
  publico: 'público',
  medico: 'médico',
};

const ACCENT_MAP = { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', n: 'ñ' };
const ACCENTABLE_CHARS = new Set(Object.keys(ACCENT_MAP));

// Genera variantes de `word` (minúscula, solo a-z) agregando tilde/eñe en 1
// o 2 posiciones simultáneamente. Acotado a como mucho 12 posiciones
// candidatas para no explotar combinatoriamente con palabras largas — más
// que suficiente para letras de canciones (líneas cortas por diseño, ver
// SYSTEM_PROMPT de run.js).
function accentVariants(word) {
  const positions = [];
  for (let i = 0; i < word.length; i++) {
    if (ACCENTABLE_CHARS.has(word[i])) positions.push(i);
  }
  const capped = positions.slice(0, 12);
  const variants = new Set();

  const applyAt = (indices) => {
    const chars = word.split('');
    for (const idx of indices) chars[idx] = ACCENT_MAP[word[idx]];
    return chars.join('');
  };

  for (const i of capped) variants.add(applyAt([i]));
  for (let a = 0; a < capped.length; a++) {
    for (let b = a + 1; b < capped.length; b++) {
      variants.add(applyAt([capped[a], capped[b]]));
    }
  }
  return [...variants];
}

// Devuelve { word, suggestions: [string,...] } para cada palabra de `text`
// que probablemente le falta una tilde o una eñe. `text` es la letra cruda
// (todas las secciones concatenadas). No mira nombres propios — el caller
// (hardValidate) ya filtra esos con canonicalStandardSpanishName antes de
// llegar acá si hace falta, pero esta función igual es conservadora: una
// palabra sin NINGUNA variante válida en el diccionario (caso típico de un
// nombre propio o respelling fonético) nunca se marca.
function findAccentTypos(text) {
  const spell = getSpellChecker();
  const found = [];
  const seen = new Set();

  const words = text.match(/[a-záéíóúüñA-ZÁÉÍÓÚÜÑ]+/g) || [];
  for (const raw of words) {
    const word = raw.toLowerCase();
    if (seen.has(word)) continue;
    seen.add(word);

    if (ENYE_TYPOS_BLOCKLIST[word]) {
      found.push({ word, suggestions: [ENYE_TYPOS_BLOCKLIST[word]] });
      continue;
    }

    // Solo palabras puramente ASCII (sin tilde/eñe ya puesta) son candidatas
    // a "le falta la tilde/eñe" — si ya tiene algún diacrítico, es un
    // problema distinto (tilde en la sílaba equivocada), fuera de alcance acá.
    if (!/^[a-z]+$/.test(word) || word.length < 3) continue;

    if (spell.correct(word)) continue; // válida tal cual (incluye "mas", "solo", "aun"...)

    const validVariants = accentVariants(word).filter((v) => spell.correct(v));
    if (validVariants.length > 0 && validVariants.length <= 3) {
      found.push({ word, suggestions: validVariants });
    }
  }

  return found;
}

module.exports = { findAccentTypos };
