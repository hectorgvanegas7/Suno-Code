// lib/languagetool-check.js — Capa 2 de defensa ortográfica/gramatical.
//
// Motivación (LESSONS.md 2026-07-11, "Fogata en la Arena", escalado por
// Hector el mismo día: "que eso NUNCA FALLE"): lib/spanish-spellcheck.js
// (Capa 1, diccionario offline vía nspell) atrapa palabras inválidas, pero
// no puede resolver AMBIGÜEDAD GRAMATICAL — "esta" (demostrativo, válida
// sin tilde) vs "está" (verbo "estar", necesita tilde) son ambas palabras
// reales; un diccionario no puede saber cuál corresponde sin entender la
// oración. LanguageTool (motor de gramática real, gratis, sin API key)
// SÍ resuelve esos casos, además de ortografía normal — verificado en vivo
// contra la API real (api.languagetool.org/v2/check) en esta sesión:
//   - "ano" -> "año" vía regla dedicada CONFUSIONS/ANO (el bug real exacto)
//   - "corazon"/"pequenas" -> TYPOS/MORFOLOGIK_RULE_ES
//   - "esta" -> "está" vía DIACRITICS/ESTA_TILDE (imposible con diccionario solo)
//   - 0 falsos positivos sobre letra ya correcta
//   - SÍ da falsos positivos sobre nombres respelleados foneticamente
//     ("Maryuri", "Yeovani", "Aandrea") — por eso el filtro de exclusión
//     de nombres de abajo es obligatorio, no opcional.
//
// process.env.LANGUAGETOOL_URL permite apuntar a una instancia self-hosted
// (Docker) más adelante sin tocar código — no instalada en esta máquina
// todavía (no hay Docker), la API pública alcanza para 1 canción a la vez
// (~20 req/min, muy por encima de lo que este pipeline necesita).

const LYRICS_SECTION_KEYS = ['Verse 1', 'Chorus 1', 'Verse 2', 'Chorus 2', 'Bridge', 'Outro'];

// Categorías de LanguageTool que se tratan como error DURO (ortografía y
// gramática real, sin ambigüedad de estilo). Cualquier otra categoría
// (ej. STYLE, REDUNDANCY, si aparecen) queda puramente informativa hasta
// calibrarla en vivo — mismo criterio que `checkLoudness`/`pacingIssues`
// en lib/audio-analysis.js: no pelear con la licencia poética que el propio
// SYSTEM_PROMPT de run.js le exige al modelo.
const HARD_FAIL_CATEGORIES = new Set(['TYPOS', 'GRAMMAR', 'CONFUSIONS', 'DIACRITICS']);

// Concatena las 6 secciones línea por línea y devuelve el texto completo +
// el mapeo de offsets de caracteres -> {section, lineIndex}, necesario
// porque LanguageTool devuelve offsets globales sobre el texto entero, no
// por línea. Pura — testeable sin red.
function buildCheckText(sections) {
  let text = '';
  const lineRanges = [];
  for (const section of LYRICS_SECTION_KEYS) {
    const lines = sections[section] || [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const start = text.length;
      text += line;
      lineRanges.push({ section, lineIndex, start, end: text.length });
      text += '\n';
    }
  }
  return { text, lineRanges };
}

// Dado el offset de un match de LanguageTool, devuelve la {section,
// lineIndex} que lo contiene, o null si cae en un separador entre líneas
// (no debería pasar en la práctica, pero mejor null que un match mal
// atribuido). Pura — testeable.
function mapOffsetToLine(offset, lineRanges) {
  for (const range of lineRanges) {
    if (offset >= range.start && offset < range.end) {
      return { section: range.section, lineIndex: range.lineIndex };
    }
  }
  return null;
}

// true si el texto marcado por LanguageTool coincide (case-insensitive,
// sin tildes) con un nombre de destinatario, una variante fonética ya usada
// en la letra, o una entrada de lib/name-dictionary.json — todos casos
// donde la "palabra" no es un error, es una respelling intencional (ver
// PHONETIC RE-SPELLING en el SYSTEM_PROMPT de run.js). Pura — testeable.
function stripAccentsLower(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
function isExcludedMatch(matchText, excludeWords) {
  const normalized = stripAccentsLower(matchText);
  return excludeWords.some((w) => stripAccentsLower(w) === normalized);
}

// Devuelve { ok: true, issues: [...] } en éxito, o { ok: false, error,
// issues: [] } si la llamada falla/timeoutea — NUNCA lanza. El caller
// (run.js) decide qué hacer con ok:false (nunca falla en silencio: se
// loguea y la canción queda marcada para revisión manual, ver LESSONS.md).
async function checkGrammarAndSpelling(
  sections,
  {
    excludeWords = [],
    apiUrl = process.env.LANGUAGETOOL_URL || 'https://api.languagetool.org/v2/check',
    timeoutMs = 8000,
  } = {}
) {
  const { text, lineRanges } = buildCheckText(sections);
  if (!text.trim()) return { ok: true, issues: [] };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const params = new URLSearchParams({ text, language: 'es' });
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `LanguageTool respondió ${response.status}: ${await response.text()}`, issues: [] };
    }
    const data = await response.json();
    const issues = filterMatches(data.matches || [], text, lineRanges, excludeWords);
    return { ok: true, issues };
  } catch (e) {
    return { ok: false, error: e.message, issues: [] };
  } finally {
    clearTimeout(timer);
  }
}

// Filtra los matches crudos de LanguageTool (categoría no-dura descartada,
// nombres/respellings excluidos) y los mapea a {section, lineIndex, kind,
// detail}. Pura — testeable con matches FAKE del mismo shape que la API
// real (verificado en vivo en esta sesión).
function filterMatches(matches, text, lineRanges, excludeWords) {
  const issues = [];
  for (const m of matches) {
    const categoryId = m.rule?.category?.id;
    if (!HARD_FAIL_CATEGORIES.has(categoryId)) continue;

    const matchText = text.slice(m.offset, m.offset + m.length);
    if (isExcludedMatch(matchText, excludeWords)) continue;

    const location = mapOffsetToLine(m.offset, lineRanges);
    if (!location) continue;

    const suggestion = m.replacements?.[0]?.value;
    const detail = suggestion
      ? `"${matchText}" — ${m.message} Sugerencia: "${suggestion}"`
      : `"${matchText}" — ${m.message}`;

    issues.push({
      section: location.section,
      lineIndex: location.lineIndex,
      kind: 'grammar_spelling',
      detail,
      matchText,
      suggestion,
    });
  }
  return issues;
}

module.exports = {
  buildCheckText,
  mapOffsetToLine,
  isExcludedMatch,
  filterMatches,
  checkGrammarAndSpelling,
  HARD_FAIL_CATEGORIES,
  LYRICS_SECTION_KEYS,
};
