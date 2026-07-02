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

// Extrae las líneas de cada sección y devuelve un objeto con el contenido real
// y los errores encontrados, independientemente de lo que Claude haya reportado.
function parseSections(fullResponse) {
  const SECTION_ORDER = ['Verse 1', 'Chorus 1', 'Verse 2', 'Chorus 2', 'Bridge', 'Outro'];
  const SECTION_REGEX = /\[(Verse 1|Chorus 1|Verse 2|Chorus 2|Bridge|Outro)\]/gi;

  const result = {};
  const matches = [...fullResponse.matchAll(SECTION_REGEX)];

  for (let i = 0; i < matches.length; i++) {
    const sectionName = matches[i][1];
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : fullResponse.length;
    const raw = fullResponse.slice(start, end);
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('**') && !l.startsWith('-'));
    result[sectionName] = lines;
  }

  const errors = [];

  // 1. Las 6 secciones deben estar presentes en el orden correcto
  const foundSections = matches.map((m) => m[1]);
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
    if (lines.length !== 4) {
      errors.push(`[${sec}] tiene ${lines.length} línea(s), debe tener exactamente 4`);
    }
  }

  return { sections: result, errors };
}

function hardValidate(fullResponse, surveyText) {
  const failures = [];

  // ── A. Estructura (secciones + líneas) ──────────────────────────────────────
  const { sections, errors: structErrors } = parseSections(fullResponse);
  failures.push(...structErrors);

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
          (n) => firstWord === n || (firstWord.length > 0 && firstWord[0] === n[0])
        );
        if (!matchedName && !isMultiRecipient) {
          failures.push(
            `[${sec}] primera palabra es "${firstWord}", debe ser uno de: ${firstNames.join(', ')} (o una variante fonética que empiece con la misma letra)`
          );
        } else if (!isMultiRecipient) {
          // Nombre solo una vez por chorus
          const nameOccurrences = lines.join(' ').toLowerCase().split(matchedName).length - 1;
          if (nameOccurrences > 1) {
            failures.push(`[${sec}] el nombre "${matchedName}" aparece ${nameOccurrences} veces, debe ser exactamente 1`);
          }
        }
      }
    });

    // ── C. Nombre(s) AUSENTE(s) en Verse 1 ─────────────────────────────────────
    const verse1Text = (sections['Verse 1'] || []).join(' ').toLowerCase();
    const leakedName = firstNames.find((n) => verse1Text.includes(n));
    if (leakedName && !isMultiRecipient) {
      failures.push(`[Verse 1] contiene el nombre "${leakedName}" — debe estar ausente`);
    }

    // MULTI-RECIPIENT FALLBACK VALIDATION
    if (isMultiRecipient) {
      const allLyricsText = Object.values(sections).flat().join(' ').toLowerCase();
      for (const name of firstNames) {
        if (!allLyricsText.includes(name)) {
          failures.push(`El nombre "${name}" no aparece en la letra, pero es uno de los destinatarios declarados`);
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

  // ── I. Mezcla de trato (usted + marcadores de tú/vos) ────────────────────
  const tratoMatch = fullResponse.match(/\*\*Trato:\*\*\s*(\w+)/i);
  const trato = tratoMatch ? tratoMatch[1].toLowerCase() : '';
  if (trato === 'usted') {
    const USTED_MISMATCH = [
      /(?<![a-záéíóúñ])no tardes(?![a-záéíóúñ])/i, /(?<![a-záéíóúñ])mirá(?![a-záéíóúñ])/i,
      /(?<![a-záéíóúñ])vení(?![a-záéíóúñ])/i, /(?<![a-záéíóúñ])decí(?![a-záéíóúñ])/i,
      /(?<![a-záéíóúñ])sabés(?![a-záéíóúñ])/i, /(?<![a-záéíóúñ])tenés(?![a-záéíóúñ])/i,
      /(?<![a-záéíóúñ])podés(?![a-záéíóúñ])/i, /(?<![a-záéíóúñ])querés(?![a-záéíóúñ])/i,
      /(?<![a-záéíóúñ])estás(?![a-záéíóúñ])/i, /(?<![a-záéíóúñ])vos(?![a-záéíóúñ])/i,
    ];
    for (const rx of USTED_MISMATCH) {
      const m = lyricsOnly.match(rx);
      if (m) failures.push(`Mezcla de trato: "${m[0]}" encontrado pero trato declarado es "usted"`);
    }
  }

  // ── J. Estilo Suno incluye seseo ──────────────────────────────────────────
  const estiloMatch = fullResponse.match(/\*\*Estilo Suno:\*\*\s*(.+)/i);
  if (estiloMatch && !estiloMatch[1].toLowerCase().includes('seseo')) {
    failures.push('Estilo Suno no incluye "seseo" + acento latinoamericano');
  }

  // ── K. Claude también marcó fallo en su propio checklist ─────────────────
  // No alcanza con buscar "✗" literal: Claude a veces marca un ítem dudoso con
  // otro símbolo (ej. "⚠️ REVISAR MANUALMENTE") en vez de ✗/✓ — eso también
  // debe contar como fallo, o se cuela sin pasar por regeneración (ver
  // LESSONS.md, caso "Harry jode").
  const checklistIndex = fullResponse.search(/\*\*QA Checklist:\*\*/i);
  if (checklistIndex !== -1) {
    const checklistBlock = fullResponse.slice(checklistIndex);
    checklistBlock.split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('-')) return;
      // Ítems marcados "(si aplica)" son condicionales: si no aplican (ej.
      // un solo destinatario), "N/A" es una respuesta válida, no un fallo.
      const isConditionalNA = /\(si aplica\)/i.test(trimmed) && /\bn\/a\b/i.test(trimmed);

      const isMultiRecipientBypass = isMultiRecipient && trimmed.includes('✗') && (
        trimmed.toLowerCase().includes('nombre = primera palabra') ||
        trimmed.toLowerCase().includes('ausente en verse 1') ||
        trimmed.toLowerCase().includes('nombre solo una vez por chorus')
      );

      if (!isMultiRecipientBypass && (trimmed.includes('✗') || (!trimmed.includes('✓') && !isConditionalNA && /[a-záéíóúñ]/i.test(trimmed)))) {
        failures.push(`Claude marcó fallo: ${trimmed}`);
      }
    });
  } else {
    failures.push('No se encontró el bloque "QA Checklist" en la respuesta');
  }

  // ── L. Texto antes de "**Título:**" (preámbulo / razonamiento filtrado) ──
  // El formato de respuesta exige "no extra text before or after". Si Claude
  // antepone razonamiento ("I need to restructure this song because...") antes
  // del bloque de título, eso terminaría guardado tal cual en song.txt.
  const tituloIndex = fullResponse.search(/\*\*Título:\*\*/i);
  if (tituloIndex > 0 && fullResponse.slice(0, tituloIndex).trim().length > 0) {
    failures.push(
      'Hay texto antes de "**Título:**" (razonamiento/preámbulo filtrado) — la respuesta debe empezar directo con el formato pedido, sin texto extra antes'
    );
  } else if (tituloIndex === -1) {
    failures.push('No se encontró "**Título:**" en la respuesta');
  }

  return { valid: failures.length === 0, failures };
}

// Verifica que el contenido a guardar tenga estructura mínima antes de escribir
// song.txt. Última línea de defensa contra respuestas truncadas o con
// chain-of-thought crudo en vez de la letra real (ver LESSONS.md).
function validateContentForWrite(lyricsContent) {
  const failures = [];

  const tituloMatch = lyricsContent.match(/\*\*Título:\*\*\s*(.+)/i);
  if (!tituloMatch || !tituloMatch[1].trim()) {
    failures.push('Falta **Título:** o está vacío (posible truncación de respuesta)');
  }

  const REQUIRED_SECTIONS = ['Verse 1', 'Chorus 1', 'Verse 2', 'Chorus 2', 'Bridge', 'Outro'];
  const { sections } = parseSections(lyricsContent);
  for (const sec of REQUIRED_SECTIONS) {
    const lines = sections[sec];
    if (!lines || lines.length === 0) {
      failures.push(`Sección [${sec}] ausente o sin contenido`);
    }
  }

  return { ok: failures.length === 0, failures };
}

function extractField(fullResponse, label) {
  const match = fullResponse.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, 'i'));
  return match ? match[1].trim() : null;
}

module.exports = { parseSections, hardValidate, validateContentForWrite, extractField };
