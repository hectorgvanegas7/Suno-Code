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

const { extractFirstNames } = require('./text-helpers');

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
];

// true solo si TODOS los fallos reportados son de las categorías parcheables
// de arriba — si hay aunque sea uno que no lo sea (ej. un nombre mal ubicado),
// no es seguro intentar el parche barato, va directo al regen completo.
function isSafeToPatch(failures) {
  return failures.length > 0 && failures.every((f) => PATCHABLE_FAILURE_PREFIXES.some((p) => f.startsWith(p)));
}

module.exports = { parseSections, hardValidate, validateContentForWrite, extractField, convertJsonToMarkdown, isSafeToPatch };
