// lib/song-validate.js — Validación estructural dura de la letra generada.
//
// Movido desde run.js (sin cambios de comportamiento) para poder testearlo
// standalone: run.js ejecuta el pipeline entero al cargarse, así que las
// funciones de validación no eran requerible-ables desde tests. Ahora
// test/song-validate.test.js las cubre con las regresiones reales de
// LESSONS.md (npm test — 100% local, sin API ni Chrome).
//
// ⚠️ Regla de mantenimiento (ver memoria/LESSONS.md): cada regla nueva del
// SYSTEM_PROMPT de run.js debe chequearse contra las suposiciones de este
// validador Y agregarse un caso al test.

const fs = require('fs');
const path = require('path');
const { distance: levenshtein } = require('fastest-levenshtein');
const { extractFirstNames } = require('./text-helpers');
const { findAccentTypos } = require('./spanish-spellcheck');

// Nombres españoles estándar/inambiguos — nunca deben respellearse
// fonéticamente (ver sección M de hardValidate más abajo y LESSONS.md
// 2026-07-10: "Jesús"→"Yeous", "Jeremías"→"Yeremías"). Lista curada, no
// exhaustiva — cubre los nombres más comunes de este negocio; nombres
// genuinamente foráneos/anglicanizados no están acá a propósito, siguen
// dependiendo del juicio del prompt + lib/name-dictionary.json.
function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}
// Mapa normalizado (sin tildes, minúscula) -> ortografía canónica correcta.
// extractFirstNames() devuelve el nombre tal como lo tipeó el cliente en la
// encuesta (minúscula, a veces SIN tilde — "jesus" en vez de "Jesús"), así
// que comparar/buscar con esa forma cruda fallaría contra la letra (que sí
// debe llevar la tilde correcta). Se busca la ortografía canónica acá y ESA
// es la que se verifica contra la letra.
const STANDARD_SPANISH_NAMES = new Map(
  JSON.parse(fs.readFileSync(path.join(__dirname, 'standard-spanish-names.json'), 'utf-8'))
    .map((n) => [stripAccents(n).toLowerCase(), n])
);
function canonicalStandardSpanishName(name) {
  return STANDARD_SPANISH_NAMES.get(stripAccents(name).toLowerCase()) || null;
}


// Regex de presencia de nombre con límite de palabra consciente del español.
// \b nativo de JS no trata á/é/í/ó/ú/ñ como caracteres de palabra, y un
// .includes()/.split() plano no tiene límite de palabra en absoluto — con
// nombres cortos como "Al" eso dispara falsos positivos con CUALQUIER palabra
// que contenga esas letras ("cristal", "final", "igual"), lo cual puede hacer
// fallar los 3 intentos de generación seguidos por un nombre que en realidad
// nunca apareció (ver LESSONS.md). Compartida por TODOS los chequeos de
// presencia/ausencia/conteo de nombre (single y multi destinatario) para que
// no queden dos varas distintas para el mismo problema.
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const SPANISH_WORD_CHAR = 'a-záéíóúñA-ZÁÉÍÓÚÑ';
function nameRegex(name, { caseSensitive = false } = {}) {
  const flags = caseSensitive ? 'g' : 'gi';
  return new RegExp(`(?<![${SPANISH_WORD_CHAR}])${escapeRegex(name)}(?![${SPANISH_WORD_CHAR}])`, flags);
}
function countNameOccurrences(text, name) {
  return (text.match(nameRegex(name)) || []).length;
}
function capitalize(name) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function parseSections(parsedJson) {
  const SECTION_ORDER = ['Verse 1', 'Chorus 1', 'Verse 2', 'Chorus 2', 'Bridge', 'Outro'];
  const result = parsedJson.letras || {};
  const errors = [];

  // 1. Las 6 secciones deben estar presentes en el orden correcto (comprobando claves)
  const foundSections = Object.keys(result);
  SECTION_ORDER.forEach((sec, idx) => {
    if (foundSections[idx] !== sec) {
      errors.push(`Sección ${idx + 1} esperada: "${sec}", encontrada: "${foundSections[idx] || 'AUSENTE'}"`);
    }
  });
  if (foundSections.length !== 6) {
    errors.push(`Se encontraron ${foundSections.length} secciones, se esperaban 6`);
  }

  // 2. Cada sección debe tener exactamente 4 líneas
  for (const [sec, lines] of Object.entries(result)) {
    if (!Array.isArray(lines)) {
      errors.push(`[${sec}] no es un array de líneas`);
    } else if (lines.length !== 4) {
      errors.push(`[${sec}] tiene ${lines.length} línea(s), debe tener exactamente 4`);
    }
  }

  return { sections: result, errors };
}

// ── Chequeo N: nombres propios inventados (2026-07-14) ──────────────────────
// Bug real ("El Hombre De Mi Vida"): la letra decía "un mismo destino nos
// cruzó por Miami" — la encuesta jamás menciona Miami (solo Cuba y Estados
// Unidos). Ni hardValidate ni El Guardia (fidelidad=10 en DOS pasadas, incluso
// con el prompt endurecido) lo atraparon: el juicio de "fidelidad" del LLM
// verifica que los TEMAS de la encuesta aparezcan, no que cada afirmación
// concreta de la letra esté respaldada. Mismo principio que el chequeo M
// (LESSONS.md, "más de vos"): un lugar/persona inventados se detectan
// determinísticamente — un token capitalizado en MEDIO de una línea es un
// nombre propio en español, y si no está en la encuesta (ni es término
// religioso permitido por la regla 8 del SYSTEM_PROMPT, ni un respelling
// fonético del destinatario), el modelo lo inventó.
//
// Falla NO parcheable a propósito (no está en PATCHABLE_FAILURE_PREFIXES):
// un hecho inventado necesita regeneración con contexto, no un parche de
// línea. El loop de generación reintenta gratis (sin créditos) y, si
// persiste, passedQA=false pausa el pipeline ANTES de Suno — cero costo.
const MIDLINE_PROPER_NOUN_WHITELIST = new Set([
  // Términos religiosos (regla 8: "God as a unifying force" — puede aparecer
  // sin estar en la encuesta) + pronombres reverenciales capitalizados.
  'dios', 'senor', 'jesus', 'cristo', 'jesucristo', 'espiritu', 'santo', 'santa',
  'padre', 'madre', 'salvador', 'creador', 'altisimo', 'rey', 'senora',
  'el', 'tu', 'su', 'sus',
]);
function normalizeToken(t) {
  return stripAccents(t).toLowerCase();
}
// Carga defensiva de los respellings del diccionario fonético curado — las
// letras escriben "Yeováni" cuando la encuesta dice "geovanny"; esos tokens
// son legítimos aunque no estén literalmente en la encuesta.
let NAME_DICT_RESPELLINGS = null;
function nameDictionaryRespellings() {
  if (NAME_DICT_RESPELLINGS) return NAME_DICT_RESPELLINGS;
  NAME_DICT_RESPELLINGS = new Set();
  try {
    const dict = JSON.parse(fs.readFileSync(path.join(__dirname, 'name-dictionary.json'), 'utf-8'));
    for (const value of Object.values(dict)) {
      for (const word of String(value).match(/[a-záéíóúüñA-ZÁÉÍÓÚÜÑ]+/g) || []) {
        NAME_DICT_RESPELLINGS.add(normalizeToken(word));
      }
    }
  } catch (e) { /* sin diccionario no hay respellings que permitir — seguir */ }
  return NAME_DICT_RESPELLINGS;
}
function findInventedProperNouns(sections, surveyText, { firstNames = [], foneticaAplicada = false } = {}) {
  const surveyTokens = new Set(
    (String(surveyText || '').match(/[a-záéíóúüñA-ZÁÉÍÓÚÜÑ]+/g) || []).map(normalizeToken)
  );
  const dictRespellings = nameDictionaryRespellings();
  const found = [];
  for (const [sec, lines] of Object.entries(sections)) {
    lines.forEach((line, idx) => {
      const rawWords = line.split(/\s+/).filter(Boolean);
      let prevEndsSentence = false;
      rawWords.forEach((raw, wordIdx) => {
        const startsNewSentence = wordIdx === 0 || prevEndsSentence || /^[¡¿"'«(]/.test(raw);
        prevEndsSentence = /[.!?…]["')»]?$/.test(raw);
        if (startsNewSentence) return; // capital de inicio de línea/oración — normal, no es señal
        const word = raw.replace(/^[^a-záéíóúüñA-ZÁÉÍÓÚÜÑ]+|[^a-záéíóúüñA-ZÁÉÍÓÚÜÑ]+$/g, '');
        // Solo Capitalizada-con-resto-minúscula (los TODO-MAYÚSCULAS son énfasis,
        // no nombres; CamelCase interno no existe en español).
        if (!/^[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+$/.test(word)) return;
        const norm = normalizeToken(word);
        if (MIDLINE_PROPER_NOUN_WHITELIST.has(norm)) return;
        if (surveyTokens.has(norm)) return;
        if (dictRespellings.has(norm)) return;
        // Respelling fonético del LLM (foneticaAplicada): tolerar variantes
        // cercanas de un nombre real de la encuesta ("Yoelin" ~ "johelyn").
        if (foneticaAplicada && firstNames.some((n) => levenshtein(norm, normalizeToken(n)) <= Math.ceil(n.length / 2))) return;
        found.push({ section: sec, lineIndex: idx, word });
      });
    });
  }
  return found;
}

function hardValidate(fullResponse, surveyText) {
  const failures = [];
  // Subconjunto de fallos ubicables a una línea exacta (sección + índice) —
  // ver isSafeToPatch()/lib/song-corrector.js. Solo se llena para las
  // categorías mecánicas y localizables (dígitos, puntuación, frase
  // incoherente, palabra repetida); todo lo demás (nombres, trato, checklist,
  // estructura) sigue sin tener entrada acá y por lo tanto nunca puede
  // "parchearse" — solo el regen completo existente los cubre.
  const patchableIssues = [];
  let parsedJson = null;

  try {
    // Buscar y extraer el bloque JSON para ser robustos frente a ruido/backticks
    const jsonMatch = fullResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");
    parsedJson = JSON.parse(jsonMatch[0]);
    
    if (jsonMatch.index > 0 && fullResponse.slice(0, jsonMatch.index).trim().length > 0) {
      failures.push('Hay texto antes del JSON (razonamiento/preámbulo filtrado) — la respuesta debe empezar directo con el formato pedido, sin texto extra antes');
    }
  } catch (e) {
    return { valid: false, failures: [`Respuesta no es un JSON válido: ${e.message}`] };
  }

  // ── A. Estructura (secciones + líneas) ──────────────────────────────────────
  const { sections, errors: structErrors } = parseSections(parsedJson);
  failures.push(...structErrors);

  // Saneamos "sections" una sola vez acá: si el LLM devolvió algo mal formado
  // para una sección (no debería pasar con additionalProperties:false + items
  // de tipo string en el schema de output_config.format, pero no hay garantía
  // absoluta — ej. el camino de "mejor esfuerzo" que usa run.js cuando los 3
  // intentos fallan parsea lo que haya, sin re-validar contra el schema),
  // cualquier valor no-array se reemplaza por [] ANTES de que los chequeos de
  // abajo hagan .forEach/.map sobre él. Sin esto, un solo campo mal formado
  // tira un TypeError no atrapado que aborta hardValidate entero en vez de
  // sumarse a `failures` como el resto de los chequeos estructurales.
  for (const sec of Object.keys(sections)) {
    if (!Array.isArray(sections[sec])) sections[sec] = [];
  }

  // Extraer nombre(s) del/de los dedicado(s) desde la encuesta. El campo puede
  // tener uno o varios nombres con relleno alrededor (ej. "Mis hijos Christopher
  // y Soraya."), así que filtramos las palabras de relleno comunes en vez de
  // asumir que la primera palabra es el nombre — eso rompía por completo la
  // validación en encuestas multi-destinatario (ver LESSONS.md).
  const firstNames = extractFirstNames(surveyText);

  const isMultiRecipient = firstNames.length > 1;

  if (firstNames.length > 0) {
    // ── B. Nombre como PRIMERA PALABRA en Chorus 1 y Chorus 2 ─────────────────
    // (con varios destinatarios, cada chorus puede abrir con un nombre distinto)
    ['Chorus 1', 'Chorus 2'].forEach((sec) => {
      const lines = sections[sec] || [];
      if (lines.length > 0) {
        const firstWord = lines[0].split(/[\s,!¡]+/)[0].toLowerCase().replace(/[^a-záéíóúüñ]/gi, '');
        // El prompt permite re-escritura fonética del nombre para Suno (ej. "Frank" -> "Frankk"),
        // así que solo exigimos que la primera letra coincida con ALGUNO de los nombres válidos,
        // en vez de igualdad exacta con un único nombre.
        const matchedName = firstNames.find(
          (n) => parsedJson.foneticaAplicada === true || firstWord === n || (firstWord.length > 0 && firstWord[0] === n[0])
        );
        if (!matchedName && !isMultiRecipient) {
          failures.push(
            `[${sec}] primera palabra es "${firstWord}", debe ser uno de: ${firstNames.join(', ')} (o una variante fonética que empiece con la misma letra)`
          );
        } else if (!isMultiRecipient) {
          // Nombre solo una vez por chorus
          const nameOccurrences = countNameOccurrences(lines.join(' ').toLowerCase(), matchedName);
          if (nameOccurrences > 1) {
            failures.push(`[${sec}] el nombre "${matchedName}" aparece ${nameOccurrences} veces, debe ser exactamente 1`);
          }
        }
      }
    });

    // ── C. Nombre(s) AUSENTE(s) en Verse 1 ─────────────────────────────────────
    // Comparación case-SENSITIVE contra la forma capitalizada del nombre, sobre
    // el texto SIN pasar a minúsculas. Nombres cortos como "Al" son idénticos a
    // palabras comunes del español ("al" = contracción de "a"+"el", muy
    // frecuente en prosa): un chequeo case-insensitive dispara con la primera
    // preposición de la letra (bug real — ver LESSONS.md, quemó 3 intentos de
    // generación seguidos por "sonriendo al caminar"). Un nombre que de verdad
    // se filtra en el Verso 1 casi siempre aparece capitalizado (se dirige/
    // refiere a una persona); la preposición nunca lo está salvo al inicio de
    // oración (caso raro que queda sin cubrir, pero mucho más angosto que
    // disparar con cualquier "al" en cualquier posición).
    const verse1TextRaw = (sections['Verse 1'] || []).join(' ');
    const leakedName = firstNames.find((n) => nameRegex(capitalize(n), { caseSensitive: true }).test(verse1TextRaw));
    if (leakedName && !isMultiRecipient) {
      failures.push(`[Verse 1] contiene el nombre "${leakedName}" — debe estar ausente`);
    }

    // MULTI-RECIPIENT: presencia como red de seguridad (aplica siempre —
    // incluso cuando hay chequeo posicional exacto abajo, esto atrapa el caso
    // de un nombre completamente ausente).
    if (isMultiRecipient) {
      const allLyricsText = Object.values(sections).flat().join(' ').toLowerCase();
      for (const name of firstNames) {
        if (parsedJson.foneticaAplicada !== true && !nameRegex(name).test(allLyricsText)) {
          failures.push(`El nombre "${name}" no aparece en la letra, pero es uno de los destinatarios declarados`);
        }
      }

      const nameInSection = (sec, name) => parsedJson.foneticaAplicada === true || (sections[sec] || []).some((line) => nameRegex(name).test(line));
      const nameInLineIdx = (sec, idx, name) => {
        if (parsedJson.foneticaAplicada === true) return true;
        const line = (sections[sec] || [])[idx];
        return !!line && nameRegex(name).test(line);
      };

      // Regla universal (cualquier cantidad de destinatarios ≥2): "NEVER list
      // all the names together in one line" — ninguna línea puede mencionar
      // más de un destinatario a la vez.
      for (const [sec, lines] of Object.entries(sections)) {
        lines.forEach((line, idx) => {
          const mentioned = firstNames.filter((n) => nameRegex(n).test(line));
          if (mentioned.length > 1) {
            failures.push(
              `[${sec}] línea ${idx + 1} menciona más de un destinatario junto (${mentioned.join(', ')}) — cada nombre debe tener su propio espacio, nunca listados en la misma línea`
            );
          }
        });
      }

      // Asignación posicional exacta que el SYSTEM_PROMPT define para 2, 3 y 4
      // destinatarios (### MULTIPLE RECIPIENTS, run.js). Para 5+ el prompt pide
      // "stagger precisely, no filler" sin mapeo fijo sección→nombre — no hay
      // regla exacta que verificar ahí, se queda solo con los chequeos de arriba.
      if (firstNames.length === 2) {
        const [n1, n2] = firstNames;
        if (!nameInSection('Chorus 1', n1)) failures.push(`[Chorus 1] debe contener a "${n1}" (regla de 2 destinatarios: Chorus 1 = Nombre 1)`);
        if (!nameInSection('Chorus 2', n2)) failures.push(`[Chorus 2] debe contener a "${n2}" (regla de 2 destinatarios: Chorus 2 = Nombre 2)`);
        if (nameInSection('Chorus 1', n2) || nameInSection('Chorus 2', n1)) {
          failures.push('Regla de 2 destinatarios violada: ambos nombres no pueden aparecer en el mismo coro');
        }
      } else if (firstNames.length === 3) {
        const [n1, n2, n3] = firstNames;
        if (!nameInSection('Chorus 1', n1)) failures.push(`[Chorus 1] debe contener a "${n1}" (regla de 3 destinatarios: Chorus 1 = Nombre 1)`);
        if (!nameInSection('Verse 2', n2)) failures.push(`[Verse 2] debe contener a "${n2}" (regla de 3 destinatarios: Verse 2 = Nombre 2)`);
        if (!nameInSection('Chorus 2', n3)) failures.push(`[Chorus 2] debe contener a "${n3}" (regla de 3 destinatarios: Chorus 2 = Nombre 3)`);
      } else if (firstNames.length === 4) {
        const assignment = [
          ['Verse 1', firstNames[0]],
          ['Chorus 1', firstNames[1]],
          ['Verse 2', firstNames[2]],
          ['Chorus 2', firstNames[3]],
        ];
        for (const [sec, name] of assignment) {
          if (!nameInLineIdx(sec, 2, name)) {
            failures.push(`[${sec}] línea 3 debe contener a "${name}" (regla de 4 destinatarios: cada nombre en línea 3 de su sección)`);
          }
        }
      }
    }
  }

  // ── D. Chorus 1 ≠ Chorus 2 (comparación línea a línea) ───────────────────
  const c1 = (sections['Chorus 1'] || []).join('\n').toLowerCase();
  const c2 = (sections['Chorus 2'] || []).join('\n').toLowerCase();
  if (c1 && c2 && c1 === c2) {
    failures.push('Chorus 1 y Chorus 2 son idénticos');
  }

  // ── E. Sin dígitos en la letra ────────────────────────────────────────────
  const lyricsOnly = Object.values(sections).flat().join('\n');
  const digitMatch = lyricsOnly.match(/\d+/);
  if (digitMatch) {
    failures.push(`Número en dígitos encontrado: "${digitMatch[0]}" — debe estar en palabras`);
  }

  // ── F. Sin em dashes, punto y coma, dos puntos en la letra ───────────────
  const forbiddenPunct = lyricsOnly.match(/[—;:]/);
  if (forbiddenPunct) {
    failures.push(`Puntuación prohibida encontrada: "${forbiddenPunct[0]}" — usar solo comas`);
  }

  // E/F otra vez, pero por línea — failures de arriba solo reporta la PRIMERA
  // ocurrencia global (para no cambiar ese comportamiento/mensajes ya
  // testeados), esto ubica TODAS las ocurrencias con su sección+línea exacta
  // para que el corrector barato (lib/song-corrector.js) sepa qué línea
  // parchear sin tener que regenerar la canción entera.
  for (const [sec, lines] of Object.entries(sections)) {
    lines.forEach((line, idx) => {
      const d = line.match(/\d+/);
      if (d) patchableIssues.push({ section: sec, lineIndex: idx, kind: 'digit', detail: `contiene "${d[0]}" — debe estar en palabras, no en dígitos` });
      const p = line.match(/[—;:]/);
      if (p) patchableIssues.push({ section: sec, lineIndex: idx, kind: 'punctuation', detail: `contiene "${p[0]}" — usar solo comas` });
    });
  }

  // ── G. Sin líneas consecutivas con la misma primera palabra ──────────────
  const allLines = Object.entries(sections).flatMap(([sec, lines]) =>
    lines.map((line, i) => ({ sec, line, i }))
  );
  for (let i = 0; i < allLines.length - 1; i++) {
    const w1 = allLines[i].line.split(/\s+/)[0].toLowerCase();
    const w2 = allLines[i + 1].line.split(/\s+/)[0].toLowerCase();
    if (w1 === w2 && w1.length > 2) {
      failures.push(
        `Líneas consecutivas con misma palabra inicial "${w1}" en [${allLines[i].sec}] línea ${allLines[i].i + 1} y [${allLines[i + 1].sec}] línea ${allLines[i + 1].i + 1}`
      );
      // Alcanza con cambiar la primera palabra de UNA de las dos líneas —
      // la segunda, para no tocar la que ya estaba bien antes que ella.
      patchableIssues.push({ section: allLines[i + 1].sec, lineIndex: allLines[i + 1].i, kind: 'repeated_first_word', detail: `empieza con la misma palabra ("${w1}") que la línea anterior — cambiá cómo arranca esta línea` });
    }
  }

  // ── H. Frases incoherentes conocidas ─────────────────────────────────────
  const KNOWN_INCOHERENT = ['nunca hemos estado difuntos', 'padre de mi mano', 'genuyo'];
  const lyricsLower = lyricsOnly.toLowerCase();
  for (const phrase of KNOWN_INCOHERENT) {
    if (lyricsLower.includes(phrase)) {
      failures.push(`Frase incoherente detectada: "${phrase}"`);
    }
  }
  for (const [sec, lines] of Object.entries(sections)) {
    lines.forEach((line, idx) => {
      const lower = line.toLowerCase();
      const hit = KNOWN_INCOHERENT.find((phrase) => lower.includes(phrase));
      if (hit) patchableIssues.push({ section: sec, lineIndex: idx, kind: 'incoherent_phrase', detail: `contiene la frase incoherente "${hit}" — reescribí la línea con sentido lógico, preservando la idea` });
    });
  }

  // ── H2. Eñe/tilde perdida en CUALQUIER palabra (no solo nombres propios) ──
  // Bug real (2026-07-11, "Fogata en la Arena"): la letra generada tenía
  // "ano" en vez de "año" y "pequena" en vez de "pequeña" y pasó
  // hardValidate entero — nada acá chequeaba ortografía de palabras comunes,
  // solo nombres propios (stripAccents/STANDARD_SPANISH_NAMES arriba). Una
  // lista fija de pares conocidos solo atrapa los casos ya vistos, así que
  // esto usa un diccionario real de español (lib/spanish-spellcheck.js, vía
  // nspell + dictionary-es) para chequear TODA palabra de la letra, no una
  // lista curada — este chequeo debe cubrir tildes y eñes en general, no
  // solo casos ya conocidos (pedido explícito de Hector tras el llamado de
  // atención de QA).
  // Palabras que H2 ya marcó (minúscula, sin tilde) — el chequeo M de abajo
  // lo consulta para no duplicar el mismo typo como fallo NO-patcheable.
  const h2FlaggedWords = new Set();
  for (const [sec, lines] of Object.entries(sections)) {
    lines.forEach((line, idx) => {
      for (const { word, suggestions } of findAccentTypos(line)) {
        const suggestionText = suggestions.length === 1 ? `"${suggestions[0]}"` : suggestions.map((s) => `"${s}"`).join(' o ');
        failures.push(`Eñe/tilde perdida: [${sec}] línea ${idx + 1} contiene "${word}" — probablemente debía ser ${suggestionText}`);
        patchableIssues.push({ section: sec, lineIndex: idx, kind: 'enye_typo', detail: `contiene "${word}", que casi seguro debía ser ${suggestionText} (falta la eñe/tilde) — corregí la ortografía sin cambiar el resto de la línea` });
        h2FlaggedWords.add(word);
      }
    });
  }

  // ── I. Mezcla de trato ────────────────────────────────────────────────────
  // Cubre los TRES tratos, no solo usted. Bug real (2026-07-09, "Luz Que No
  // Buscaba", en vivo): con trato "Tú" el modelo cerró un verso con "más de
  // vos" (las reglas de rima fuerte + vocal abierta lo empujan a rimar con
  // "voz/dos/sol") y este chequeo NO existía para tú — el voseo pasó limpio
  // hasta el audio generado. Créditos gastados, canción frenada a mano antes
  // del Submit. Mismo patrón de límites acentuados que USTED_MISMATCH (nunca
  // \b — ver la lección de "vení"/"venía" en LESSONS.md).
  const trato = (parsedJson.trato || '').toLowerCase().replace(/ú/g, 'u');
  const tratoBoundary = (word) => new RegExp(`(?<![a-záéíóúñ])${word}(?![a-záéíóúñ])`, 'i');
  const TRATO_MISMATCH_MARKERS = {
    usted: ['no tardes', 'mirá', 'vení', 'decí', 'sabés', 'tenés', 'podés', 'querés', 'estás', 'vos'],
    // Con tú: cualquier voseo es mezcla. "vos" es el caso real visto en vivo;
    // el resto son las formas verbales voseantes de más alta frecuencia.
    // OJO: "estás" NO va acá (es tú correcto); "tuteo" posesivo ("tu"/"te")
    // tampoco (vos también los usa).
    tu: ['vos', 'sos', 'tenés', 'podés', 'querés', 'sabés', 'hacés', 'decís', 'venís', 'vení', 'decí', 'mirá', 'andá', 'hacé', 'no tardés'],
    // Con vos: los marcadores exclusivos de tú.
    vos: ['contigo', 'eres', 'tienes', 'puedes', 'quieres', 'sabes', 'ti'],
  };
  const mismatchMarkers = TRATO_MISMATCH_MARKERS[trato] || [];
  for (const marker of mismatchMarkers) {
    const m = lyricsOnly.match(tratoBoundary(marker));
    if (m) failures.push(`Mezcla de trato: "${m[0]}" encontrado pero trato declarado es "${parsedJson.trato}"`);
  }

  // ── J. Estilo Suno incluye seseo ──────────────────────────────────────────
  const estiloSuno = (parsedJson.estiloSuno || '').toLowerCase();
  if (!estiloSuno.includes('seseo')) {
    failures.push('Estilo Suno no incluye "seseo" + acento latinoamericano');
  }

  // ── K. Claude también marcó fallo en su propio checklist ─────────────────
  const checklist = parsedJson.qaChecklist || {};
  for (const [key, passed] of Object.entries(checklist)) {
    // Si la regla de nombre falla, pero es por múltiples destinatarios, lo toleramos
    const isMultiRecipientBypass = isMultiRecipient && (
      key.includes('nombre_primera_palabra') ||
      key.includes('nombre_ausente_en_verse_1') ||
      key.includes('nombre_solo_una_vez_por_chorus')
    );
    if (!passed && !isMultiRecipientBypass) {
      failures.push(`Claude marcó fallo en checklist: ${key}`);
    }
  }

  // ── L. Título ausente ──
  if (!parsedJson.titulo || parsedJson.titulo.trim() === '') {
    failures.push('El título está vacío o ausente');
  }

  // ── M. Nombres españoles estándar NUNCA deben respellearse fonéticamente ──
  // Bug real (2026-07-10, ver LESSONS.md): "Jesús"→"Yeous", "Jeremías"→
  // "Yeremías" — el LLM sobre-generalizó la regla de respelling del prompt a
  // nombres que ya eran español estándar. El chequeo B de arriba (primera
  // palabra del Chorus) tiene un bypass explícito para foneticaAplicada=true
  // que deja pasar CUALQUIER variante con la primera letra correcta — ese es
  // exactamente el agujero que dejó pasar "Yeousalejandro". Este chequeo es
  // independiente y determinístico: si el nombre es español estándar (lista
  // curada en lib/standard-spanish-names.json), esa ortografía EXACTA debe
  // aparecer literalmente en algún lugar de la letra, sin importar qué diga
  // foneticaAplicada ni ningún otro bypass. Backstop pedido por Hector tras
  // ver el mismo tipo de error dos veces en la misma sesión — un fix del
  // prompt no es suficiente por sí solo (ver "más de vos" en LESSONS.md, el
  // mismo principio: lo duro tiene que vivir acá, no en una instrucción de
  // texto que el modelo puede ignorar).
  for (const name of firstNames) {
    const canonical = canonicalStandardSpanishName(name);
    if (canonical && !nameRegex(canonical).test(lyricsOnly)) {
      // Antes de reportar como "posible re-escritura indebida" (bug real
      // 2026-07-10: "Yeous", "Yeremías"), chequear si lo que realmente pasó
      // es más simple: la MISMA palabra sin tilde/eñe está ahí ("Maria" en
      // vez de "María"). Ese caso es un typo mecánico patcheable, no un
      // respelling — reportarlo con el mismo prefijo NO patcheable de abajo
      // bloqueaba el parche barato para el 100% de los casos y forzaba un
      // regen completo caro que no lo arreglaba de forma confiable (bug real
      // 2026-07-13, "El Lago Donde Aprendí a Quedarme": 3 intentos seguidos
      // sin corregir "maria"→"María").
      //
      // ⚠️ NO alcanza con suprimirlo asumiendo que H2 ya lo reportó: H2
      // depende de que el diccionario acepte la forma acentuada en
      // MINÚSCULA, y dictionary-es solo trae así unos pocos nombres
      // ("maría" sí, "jesús"/"josé" NO — verificado 2026-07-13: 42 de los
      // 58 nombres acentuados de standard-spanish-names.json son invisibles
      // para H2). La primera versión de este fix suprimía el fallo sin
      // reportar nada, con lo cual "Jesus"/"Jose" sin tilde pasaban la
      // validación ENTERA en silencio. Ahora: si H2 no lo cubrió, se
      // reporta acá mismo como "Eñe/tilde perdida" (prefijo patcheable) con
      // sección+línea, y applyDeterministicAccentFixes lo arregla gratis
      // usando la ortografía canónica de la lista curada.
      const unaccentedForm = stripAccents(canonical).toLowerCase();
      const hasUnaccentedForm = nameRegex(unaccentedForm).test(lyricsOnly);
      if (hasUnaccentedForm) {
        if (!h2FlaggedWords.has(unaccentedForm)) {
          for (const [sec, lines] of Object.entries(sections)) {
            lines.forEach((line, idx) => {
              if (nameRegex(unaccentedForm).test(line)) {
                failures.push(`Eñe/tilde perdida: [${sec}] línea ${idx + 1} contiene "${unaccentedForm}" — probablemente debía ser "${canonical}"`);
                patchableIssues.push({ section: sec, lineIndex: idx, kind: 'enye_typo', detail: `contiene el nombre "${unaccentedForm}" sin su tilde/eñe — debe escribirse exactamente "${canonical}", sin cambiar el resto de la línea` });
              }
            });
          }
        }
      } else {
        failures.push(
          `El nombre "${canonical}" es español estándar y NUNCA debe respellearse fonéticamente, pero no aparece con su ortografía original en la letra — posible re-escritura indebida (ej. "Yeous", "Yeremías")`
        );
      }
    }
  }

  // ── N. Nombres propios inventados (ver findInventedProperNouns arriba) ────
  for (const { section, lineIndex, word } of findInventedProperNouns(sections, surveyText, {
    firstNames,
    foneticaAplicada: parsedJson.foneticaAplicada === true,
  })) {
    failures.push(
      `Nombre propio ausente de la encuesta: [${section}] línea ${lineIndex + 1} contiene "${word}" — la letra no puede nombrar lugares/personas/hechos que la encuesta no menciona (regla "Nothing invented"; si es una palabra común, no debería ir capitalizada en medio de la línea)`
    );
  }

  return { valid: failures.length === 0, failures, parsedJson, patchableIssues };
}

function validateContentForWrite(parsedJson) {
  const failures = [];

  if (!parsedJson || !parsedJson.titulo || !parsedJson.titulo.trim()) {
    failures.push('Falta **Título:** o está vacío (posible truncación de respuesta)');
  }

  const REQUIRED_SECTIONS = ['Verse 1', 'Chorus 1', 'Verse 2', 'Chorus 2', 'Bridge', 'Outro'];
  const { sections } = parseSections(parsedJson);
  for (const sec of REQUIRED_SECTIONS) {
    const lines = sections[sec];
    if (!lines || !Array.isArray(lines) || lines.length === 0) {
      failures.push(`Sección [${sec}] ausente o sin contenido`);
    }
  }

  return { ok: failures.length === 0, failures };
}

function extractField(fullResponse, label) {
  try {
    const match = fullResponse.match(/\{[\s\S]*\}/);
    const json = JSON.parse(match[0]);
    if (label.toLowerCase() === 'título') return json.titulo;
  } catch (e) {
    return null;
  }
  return null;
}

// Convierte el JSON generado a formato Markdown para song.txt
function convertJsonToMarkdown(parsedJson) {
  const lyrics = Object.entries(parsedJson.letras || {})
    .map(([sec, lines]) => `[${sec}]\n${lines.join('\n')}`)
    .join('\n\n');

  const advertenciasLine = parsedJson.advertencias && !/^ninguna\.?$/i.test(parsedJson.advertencias.trim())
    ? `**Advertencias:** ${parsedJson.advertencias.trim()}`
    : '';

  const checklistLines = Object.entries(parsedJson.qaChecklist || {})
    .map(([k, v]) => `- ${k}: ${v ? '✓' : '✗'}`)
    .join('\n');

  return `**Título:** ${parsedJson.titulo}
**Voz:** ${parsedJson.voz}
**Trato:** ${parsedJson.trato}
**Estilo Suno:** ${parsedJson.estiloSuno}

---

${lyrics}

---

**QA Checklist:**
${checklistLines}

${advertenciasLine}`.trim();
}

// Categorías de fallo que el corrector barato (lib/song-corrector.js) puede
// arreglar parcheando líneas puntuales en vez de regenerar la canción entera
// con el modelo caro. Deliberadamente conservador: nombres, trato, checklist
// y estructura NO están acá — esos siempre van al regen completo existente.
const PATCHABLE_FAILURE_PREFIXES = [
  'Número en dígitos encontrado',
  'Puntuación prohibida encontrada',
  'Líneas consecutivas con misma palabra inicial',
  'Frase incoherente detectada',
  'Eñe/tilde perdida',
];

// true solo si TODOS los fallos reportados son de las categorías parcheables
// de arriba — si hay aunque sea uno que no lo sea (ej. un nombre mal ubicado),
// no es seguro intentar el parche barato, va directo al regen completo.
function isSafeToPatch(failures) {
  return failures.length > 0 && failures.every((f) => PATCHABLE_FAILURE_PREFIXES.some((p) => f.startsWith(p)));
}

// Preserva el "case" del texto original al sustituir una palabra: todo
// mayúsculas se mantiene ("MARIA"->"MARÍA", no "María"), inicial mayúscula
// se mantiene ("Maria"->"María"), minúscula queda minúscula.
function preserveCase(original, replacement) {
  if (original.length > 1 && original === original.toUpperCase()) return replacement.toUpperCase();
  if (original[0] === original[0].toUpperCase()) return capitalize(replacement);
  return replacement;
}

// Corrector DETERMINÍSTICO de tildes/eñes — cero LLM, cero costo, cero
// ambigüedad. Bug real 2026-07-13 ("El Lago Donde Aprendí a Quedarme"):
// "maria"->"María" sobrevivió 3 regeneraciones completas con Sonnet (con
// instrucciones correctivas explícitas cada vez) porque el modelo no lo
// corregía de forma confiable. Para el subconjunto de typos donde
// findAccentTypos() ya encontró UNA sola sustitución válida en el
// diccionario (sin ambigüedad — ver spanish-spellcheck.js), no hace falta
// pagarle a NINGÚN modelo (ni siquiera el corrector barato de Haiku en
// song-corrector.js) para hacer un reemplazo de texto directo. Usa el mismo
// límite de palabra consciente del español que el resto del validador
// (nameRegex). Dos exclusiones a propósito:
//   - suggestions.length !== 1 (ambigüedad, ej. "rocio"->rocío/roció): se
//     deja para el corrector de Haiku o el regen completo, igual que antes.
//   - needsContext (homógrafos plausibles del blocklist, ej. "papa"/"sueno"
//     — ver ENYE_TYPOS_BLOCKLIST_CONTEXT en spanish-spellcheck.js): "El
//     Papa nos bendijo" NO debe volverse "El Papá" por un reemplazo ciego;
//     solo Haiku (que ve la línea con contexto) puede decidir.
//
// opts.firstNames (los nombres crudos de la encuesta, extractFirstNames):
// habilita la corrección determinística de NOMBRES españoles estándar sin
// tilde ("Jesus"->"Jesús") usando la ortografía canónica de la lista curada
// — el diccionario NO cubre la mayoría de estos en minúscula (42/58,
// verificado 2026-07-13), así que el camino de findAccentTypos no los ve.
// Solo reemplaza ocurrencias CAPITALIZADAS: un token minúscula idéntico a
// un nombre puede ser una palabra común real (recipiente "Tomás" + "cuando
// tomas mi mano" — el verbo jamás debe volverse el nombre).
function applyDeterministicAccentFixes(letras, { firstNames = [] } = {}) {
  let appliedCount = 0;
  const fixedLetras = {};

  const nameFixes = [];
  for (const rawName of firstNames) {
    const canonical = canonicalStandardSpanishName(rawName);
    if (!canonical) continue;
    const unaccented = stripAccents(canonical).toLowerCase();
    if (unaccented === canonical.toLowerCase()) continue; // nombre sin tilde/eñe — nada que corregir
    nameFixes.push({ unaccented, canonical });
  }

  for (const [sec, lines] of Object.entries(letras || {})) {
    fixedLetras[sec] = (lines || []).map((line) => {
      let newLine = line;
      for (const { word, suggestions, needsContext } of findAccentTypos(line)) {
        if (suggestions.length !== 1 || needsContext) continue;
        const suggestion = suggestions[0];
        newLine = newLine.replace(nameRegex(word), (match) => {
          appliedCount++;
          return preserveCase(match, suggestion);
        });
      }
      for (const { unaccented, canonical } of nameFixes) {
        newLine = newLine.replace(nameRegex(unaccented), (match) => {
          if (match[0] !== match[0].toUpperCase()) return match; // minúscula: puede ser palabra común, no tocar
          appliedCount++;
          return canonical;
        });
      }
      return newLine;
    });
  }
  return { letras: fixedLetras, appliedCount };
}

// Puntuación prohibida (em dash / punto y coma / dos puntos -> coma) — 100%
// determinística, no hace falta ni Haiku: la regla del SYSTEM_PROMPT es
// "usar solo comas", así que el reemplazo es mecánico. Normaliza espacios y
// comas duplicadas que pueda dejar el reemplazo ("palabra — otra" ->
// "palabra, otra"; "así:" al final de línea -> "así,").
function fixForbiddenPunctuationInLine(line) {
  let s = line.replace(/\s*[—;]\s*/g, ', ');
  s = s.replace(/(?<!\d):(?!\d)\s*/g, ', ');
  s = s.replace(/,(\s*,)+/g, ',');   // ",  ," -> ","
  s = s.replace(/\s+,/g, ',');       // "palabra ," -> "palabra,"
  s = s.replace(/,(?!\s|$)/g, ', '); // "palabra,otra" -> "palabra, otra"
  s = s.replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/^,\s*/, '');        // línea que ARRANCABA con em dash
  s = s.replace(/,\s*$/, ',');       // ", " colgante al final -> ","
  return s;
}

// Números en dígitos -> palabras en español. Solo el subconjunto SIN
// problemas de género/apócope: los que terminan en 1 (salvo 11) necesitan
// "un/uno/una" según el sustantivo ("veintiún años" vs "veintiuno") y los
// 200-999 concuerdan en género ("doscientas rosas") — esos se dejan al
// corrector de Haiku, que ve el contexto. Cubre 1-199 y años 1900-2099,
// que es lo que aparece en encuestas reales (edades, aniversarios, años).
const NUM_0_29 = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const NUM_TENS = { 30: 'treinta', 40: 'cuarenta', 50: 'cincuenta', 60: 'sesenta', 70: 'setenta', 80: 'ochenta', 90: 'noventa' };
function numberToSpanishWords(n) {
  if (!Number.isInteger(n) || n < 0) return null;
  if (n % 10 === 1 && n !== 11) return null; // apócope un/uno/una — necesita contexto
  if (n < 30) return NUM_0_29[n];
  if (n < 100) {
    const tens = Math.floor(n / 10) * 10;
    const rest = n % 10;
    return rest === 0 ? NUM_TENS[tens] : `${NUM_TENS[tens]} y ${NUM_0_29[rest]}`;
  }
  if (n === 100) return 'cien';
  if (n < 200) return `ciento ${numberToSpanishWords(n - 100)}`;
  if (n >= 1900 && n < 2000) {
    const rest = n - 1900;
    return rest === 0 ? 'mil novecientos' : `mil novecientos ${numberToSpanishWords(rest)}`;
  }
  if (n >= 2000 && n < 2100) {
    const rest = n - 2000;
    return rest === 0 ? 'dos mil' : `dos mil ${numberToSpanishWords(rest)}`;
  }
  return null; // género/rango no cubierto — Haiku con contexto
}
function fixDigitsInLine(line) {
  return line.replace(/\d+/g, (m) => {
    // "007" o el "000" de un "1,000" partido por la coma NO son el número
    // que parseInt cree — mejor dejarlos para Haiku que inventar un "cero".
    if (m.length > 1 && m.startsWith('0')) return m;
    const words = numberToSpanishWords(parseInt(m, 10));
    return words === null ? m : words;
  });
}

// Orquestador de TODAS las correcciones determinísticas por línea (tildes/
// eñes + nombres estándar + puntuación prohibida + dígitos) — lo que llama
// run.js tras cada hardValidate fallido, antes de gastar Haiku o un regen.
// Devuelve también qué se corrigió, para poder auditar en el run-log qué
// tocó el corrector (nunca corregir en silencio sin dejar rastro).
function applyDeterministicLineFixes(letras, { firstNames = [] } = {}) {
  const fixes = [];
  const { letras: accentFixed, appliedCount: accentCount } = applyDeterministicAccentFixes(letras, { firstNames });
  if (accentCount > 0) fixes.push(`${accentCount} tilde(s)/eñe(s)`);

  let punctCount = 0;
  let digitCount = 0;
  const fixedLetras = {};
  for (const [sec, lines] of Object.entries(accentFixed || {})) {
    fixedLetras[sec] = (lines || []).map((line) => {
      let newLine = line;
      if (/[—;:]/.test(newLine)) {
        const fixed = fixForbiddenPunctuationInLine(newLine);
        if (fixed !== newLine) { punctCount++; newLine = fixed; }
      }
      if (/\d/.test(newLine)) {
        const fixed = fixDigitsInLine(newLine);
        if (fixed !== newLine) { digitCount++; newLine = fixed; }
      }
      return newLine;
    });
  }
  if (punctCount > 0) fixes.push(`puntuación prohibida en ${punctCount} línea(s)`);
  if (digitCount > 0) fixes.push(`dígitos->palabras en ${digitCount} línea(s)`);

  return { letras: fixedLetras, appliedCount: accentCount + punctCount + digitCount, fixes };
}

module.exports = { parseSections, hardValidate, validateContentForWrite, extractField, convertJsonToMarkdown, isSafeToPatch, applyDeterministicAccentFixes, applyDeterministicLineFixes, numberToSpanishWords, canonicalStandardSpanishName, findInventedProperNouns };
