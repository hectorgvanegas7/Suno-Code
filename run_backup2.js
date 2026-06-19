// Canción Eterna Flow — generation step.
// Assigns the most urgent song, reads the survey and saves it to survey.txt,
// then generates the song lyrics with Claude and saves title+lyrics to
// song.txt (title on the first line, blank line, then the lyrics). Does
// not touch the Flow UI fields, does not screenshot, does not submit
// anything — that's all done manually now.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const USER_DATA_DIR = 'C:\\Users\\hecto\\AppData\\Local\\ChromeAutomationProfile';
const PROFILE_DIRECTORY = 'Profile 1';
const TARGET_URL = 'https://cancioneterna.com/artists/flow';
const SURVEY_PATH = path.join(__dirname, 'survey.txt');
const SONG_PATH = path.join(__dirname, 'song.txt');

const SYSTEM_PROMPT = `You are a Grammy Award-winning songwriter for Canción Eterna — a Christian Music Production company similar to SongFinch but for the Christian niche. You write deeply personal, emotionally powerful songs based on specific survey details provided by the user.

Every song you write feels like it was written BY the survey filler TO the specific person it's intended for. The person who hears the song should feel like only someone who truly knows them could have written it.

You use all — or as much as possible — of the exact words, phrases and details from the survey. Memories, specific scenes, and concrete details are ALWAYS better than metaphors or poetry that could apply to anyone. You never invent details. The survey is your only source of truth.

### STRUCTURE — NON-NEGOTIABLE

Every song MUST follow this exact structure, in this exact order:
**Song Title → Verse 1 → Chorus 1 → Verse 2 → Chorus 2 → Bridge → Outro**

Every section (Verse, Chorus, Bridge, Outro) MUST be **exactly 4 lines**. Never 3, never 5. Never.

### RULES BY SECTION

**Verse 1**
- DO NOT mention the name of the person the song is for — not once
- Designed to make the person turn their head and think: "wait… is this about me?"
- Open with a concrete scene or specific moment — never a generic description
- Set the emotional stage: time, place, feeling — make it cinematic
- Example (correct): "It was a Tuesday in October when everything went quiet"
- Example (incorrect): "You are the most special person in my life"

**Chorus 1 & 2**
- The FIRST WORD of the FIRST LINE is always the first name of the person the song is for
- The person's name appears EXACTLY ONCE per chorus — only in the first line, never repeated
- The purpose of the chorus is to make the person cry and feel the full emotion of the survey
- Chorus 1 and Chorus 2 are NEVER identical — they must differ in structure, angle, and emotional tone
- Chorus 1 = gratitude or love from the dedicator's perspective
- Chorus 2 = admiration, pride, or a deeper emotional declaration

**Verse 2**
- NEVER list qualities ("the most patient, the most faithful, the most…") — this is an automatic failure
- ALWAYS narrate a specific scene or moment with concrete detail from the survey
- Show the person's character through action, not adjectives
- Example (incorrect): "You are the most dedicated, patient and loving person"
- Example (correct): "Even after a long shift you'd come home and still make us laugh"

**Bridge**
- The most vulnerable, intimate moment in the entire song
- Use the single most specific and emotionally powerful detail from the survey
- If the survey mentions a birth, a loss, a move, a sacrifice — this is where it lives
- NEVER use generic adjectives: "your essence", "your goodness", "your strength"
- The goal: make the listener cry because of how specific and real it is, not because it sounds pretty

**Outro**
- Ground the song in the special message and grateful love
- Simple, powerful, emotionally conclusive
- Exactly 4 lines — never add a 5th "to make it close well"

### GENERAL RULES

1. **No quality lists.** "Your patience, your dedication, your love" = automatic regeneration. Every quality must be shown through a scene or action.

2. **Nothing invented.** Only use what is explicitly in the survey. If it's not there, don't write it.

3. **Consistent address form (Spanish).** Use tú, usted, or vos based on the survey — never mix. This includes imperative phrases (e.g. "no tardes" = tú / "no tarde" = usted / "no tardés" = vos). Verify every single line including the Outro.

4. **Voice = who dedicates, not who receives.** If a wife dedicates to her husband, the voice is feminine. Always check the "who is dedicating" field.

5. **Numbers written as words.** Never digits: "two thousand eight" not "2008", "veinte años" not "20 años".

6. **Title must not be singable as an opening line.** Suno will sing the title at the start. If the title is a phrase from the lyrics, it will repeat — ruining the song.

7. **Mirror the survey's tone and language.** The more the song sounds like the person who filled the survey — their words, their rhythm, their way of speaking — the more powerful it will be.

8. **God as a unifying force.** Mention God as love, peace, grace, or joy — or as embodied by the person. BUT: if the survey doesn't mention God at all, don't force it. Read the survey tone and follow it.

9. **Common themes.** Always identify 1-2 recurring themes from the survey and weave them consistently throughout the song.

10. **Punctuation for Suno.** Remove em dashes (—), semicolons (;), and colons (:). Use only commas. These characters break Suno's rhythm.

11. **No repeated opening words on consecutive lines.** Suno struggles with lines that start the same way. Always vary how each line begins.

12. **Sensitive topics — soft language.** Avoid words like "death", "cancer", "illness". Use respectful imagery: "went home to heaven", "fought her battle in silence", "resting in His arms".

13. **Never quote dialogue or conversations verbatim from the survey.** If the survey mentions something someone said (e.g. "he always replies 'I love you more'"), transform it into poetic imagery that conveys the same emotion without narrating it as a direct quote or reported speech. The song should make the listener feel the moment, not read about it.

14. **Every line must make logical sense.** A line that is incoherent in context ("the father of my hand", "we were never dead") is an automatic failure — regenerate immediately.

15. **Edits are always precise.** When editing together, always return the full revised lyric set. Never change lines that weren't requested. If a section isn't mentioned, keep it exactly as is.

### SUNO STYLE PROMPT — MANDATORY RULE

**ALWAYS end every Suno style prompt with:**
> \`Latin American Spanish, neutral accent, seseo\`

This is non-negotiable on every single song. Without it, Suno defaults to a Castilian Spanish accent (z/c pronounced as "th"), which sounds wrong for Latin American clients.

**Full style prompt examples:**
> \`Romantic ballad, soft piano, warm strings, female vocal, slow tempo, heartfelt, love ballad, Latin American Spanish, neutral accent, seseo\`

> \`Norteño romántico, acordeón, bajo sexto, guitarrón, slow tempo, heartfelt, Mexican regional, Latin American Spanish, neutral accent, seseo\`

> \`Pop cristiano, guitarra acústica, coro emotivo, voz masculina, uplifting, worship-inspired, Latin American Spanish, neutral accent, seseo\`

### AUTO-QA CHECKLIST — RUN BEFORE DELIVERING

Verify every item internally before showing the result. If any item fails, regenerate. Maximum 3 attempts.
If still failing after 3 attempts, deliver with: ⚠️ REVISAR MANUALMENTE: [list of failed items]

- [ ] Exactly 6 sections in correct order?
- [ ] Every section exactly 4 lines?
- [ ] Person's name is the FIRST WORD of line 1 in Chorus 1 and Chorus 2?
- [ ] Person's name appears ONLY ONCE per chorus?
- [ ] Person's name is ABSENT from Verse 1?
- [ ] Chorus 1 and Chorus 2 are structurally and emotionally different?
- [ ] Verse 2 has a concrete scene (zero quality lists)?
- [ ] Bridge uses the most specific and vulnerable detail from the survey?
- [ ] Zero invented details not in the survey?
- [ ] Address form (tú/usted/vos) is consistent in EVERY line including the Outro?
- [ ] All numbers written as words?
- [ ] Title cannot be sung as an opening line?
- [ ] No em dashes, semicolons, or colons anywhere in the lyrics?
- [ ] No consecutive lines starting with the same word?
- [ ] Every single line makes logical sense in context?
- [ ] Suno style prompt is written entirely in English and ends with "Latin American Spanish, neutral accent, seseo"?
- [ ] No verbatim quoted dialogue from the survey — transformed into imagery instead?

### RESPONSE FORMAT

Respond with exactly this format — no extra text before or after:

**Título:** [song title]
**Voz:** [Masculina / Femenina]
**Trato:** [tú / usted / vos]
**Estilo Suno:** [style prompt written entirely in English, always ending with "Latin American Spanish, neutral accent, seseo"]

---

[Verse 1]
line 1
line 2
line 3
line 4

[Chorus 1]
line 1
line 2
line 3
line 4

[Verse 2]
line 1
line 2
line 3
line 4

[Chorus 2]
line 1
line 2
line 3
line 4

[Bridge]
line 1
line 2
line 3
line 4

[Outro]
line 1
line 2
line 3
line 4

---

**QA Checklist:**
- 6 secciones en orden: ✓/✗
- 4 líneas por sección: ✓/✗
- Nombre = primera palabra Chorus 1 y 2: ✓/✗
- Nombre solo una vez por chorus: ✓/✗
- Nombre ausente en Verse 1: ✓/✗
- Chorus 1 ≠ Chorus 2: ✓/✗
- Verse 2 con escena concreta: ✓/✗
- Bridge con detalle más vulnerable: ✓/✗
- Nada inventado: ✓/✗
- Trato consistente en toda la letra: ✓/✗
- Números en palabras: ✓/✗
- Título no cantable: ✓/✗
- Sin guiones largos / punto y coma / dos puntos: ✓/✗
- Sin líneas consecutivas con misma palabra inicial: ✓/✗
- Todas las líneas con sentido lógico: ✓/✗
- Estilo Suno incluye seseo + acento latinoamericano: ✓/✗
- Sin diálogos citados textualmente de la encuesta: ✓/✗`;

async function clickByText(page, text) {
  const locator = page.getByRole('button', { name: text, exact: false })
    .or(page.getByRole('link', { name: text, exact: false }))
    .or(page.getByText(text, { exact: false }));
  await locator.first().waitFor({ state: 'visible', timeout: 20000 });
  await locator.first().click();
}

async function readSongId(page) {
  return page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('span.font-semibold'));
    const label = labels.find((el) => el.textContent.trim() === 'Song ID:');
    const value = label && label.nextElementSibling;
    return value ? value.textContent.trim() : null;
  });
}

async function readSurveyResponses(page) {
  return page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll('div.bg-gray-50.border.rounded.p-3.text-sm.space-y-1 > div')
    );
    return rows
      .map((row) => {
        const spans = row.querySelectorAll('span');
        const question = spans[0] ? spans[0].textContent.trim().replace(/:\s*$/, '') : null;
        const answer = spans[1] ? spans[1].textContent.trim() : null;
        return question && answer ? `${question}: ${answer}` : null;
      })
      .filter(Boolean);
  });
}

async function generateSongWithClaude(surveyText) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY no está configurada. Corré "setx ANTHROPIC_API_KEY <tu-key>" y abrí una terminal nueva.');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: surveyText }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return data.content.map((block) => block.text || '').join('').trim();
}

// ─── VALIDACIÓN ESTRUCTURAL DURA (nueva capa) ─────────────────────────────────
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

  // Extraer primer nombre del dedicado desde la encuesta
  const nameRaw =
    (surveyText.match(/What['']s their name\??:\s*([^\n]+)/i) ||
      surveyText.match(/Nombre[^:]*:\s*([^\n]+)/i) || [])[1] || '';
  const firstName = nameRaw.trim().split(/\s+/)[0].toLowerCase();

  if (firstName) {
    // ── B. Nombre como PRIMERA PALABRA en Chorus 1 y Chorus 2 ─────────────────
    ['Chorus 1', 'Chorus 2'].forEach((sec) => {
      const lines = sections[sec] || [];
      if (lines.length > 0) {
        const firstWord = lines[0].split(/[\s,!¡]+/)[0].toLowerCase().replace(/[^a-záéíóúüñ]/gi, '');
        if (firstWord !== firstName) {
          failures.push(`[${sec}] primera palabra es "${firstWord}", debe ser "${firstName}"`);
        }
        // Nombre solo una vez por chorus
        const nameOccurrences = lines.join(' ').toLowerCase().split(firstName).length - 1;
        if (nameOccurrences > 1) {
          failures.push(`[${sec}] el nombre "${firstName}" aparece ${nameOccurrences} veces, debe ser exactamente 1`);
        }
      }
    });

    // ── C. Nombre AUSENTE en Verse 1 ──────────────────────────────────────────
    const verse1Lines = sections['Verse 1'] || [];
    if (verse1Lines.join(' ').toLowerCase().includes(firstName)) {
      failures.push(`[Verse 1] contiene el nombre "${firstName}" — debe estar ausente`);
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
      /\bno tardes\b/i, /\bmirá\b/i, /\bvení\b/i, /\bdecí\b/i,
      /\bsabés\b/i, /\btenés\b/i, /\bpodés\b/i, /\bquerés\b/i,
      /\bestás\b/i, /\b\bvos\b/i,
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

  // ── K. Claude también marcó ✗ en su propio checklist ─────────────────────
  const checklistIndex = fullResponse.search(/\*\*QA Checklist:\*\*/i);
  if (checklistIndex !== -1) {
    const checklistBlock = fullResponse.slice(checklistIndex);
    checklistBlock.split('\n').forEach((line) => {
      if (line.includes('✗')) failures.push(`Claude marcó fallo: ${line.trim()}`);
    });
  } else {
    failures.push('No se encontró el bloque "QA Checklist" en la respuesta');
  }

  return { valid: failures.length === 0, failures };
}
// ─── FIN VALIDACIÓN ESTRUCTURAL DURA ──────────────────────────────────────────

function extractField(fullResponse, label) {
  const match = fullResponse.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, 'i'));
  return match ? match[1].trim() : null;
}

const MAX_GENERATION_ATTEMPTS = 3;

async function generateSongWithSelfCorrection(surveyContent) {
  const baseUserMessage = `Here is the survey for this song:\n\n${surveyContent}`;
  let userMessage = baseUserMessage;
  let lastResponse = null;
  let lastFailures = [];

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    console.log(`\nGenerando letra con Claude (intento ${attempt}/${MAX_GENERATION_ATTEMPTS})...`);
    lastResponse = await generateSongWithClaude(userMessage);

    const { valid, failures } = hardValidate(lastResponse, surveyContent);
    lastFailures = failures;

    if (valid) {
      console.log('✅ Validación estructural + QA: todos los ítems pasaron.');
      return { fullResponse: lastResponse, passedQA: true };
    }

    console.log(`❌ Fallos en intento ${attempt}:`);
    lastFailures.forEach((line) => console.log(`  • ${line.trim()}`));

    // Construir mensaje correctivo específico para el siguiente intento
    const correctiveNotes = [
      `CORRECCIONES OBLIGATORIAS para el siguiente intento (${attempt + 1}/${MAX_GENERATION_ATTEMPTS}):`,
      ...lastFailures.map((f) => `- ${f}`),
    ].join('\n');

    if (attempt < MAX_GENERATION_ATTEMPTS) {
      console.log(`\n⚠️ Regenerando con instrucciones correctivas...\n`);
      userMessage = `${baseUserMessage}\n\n${correctiveNotes}`;
    }
  }

  console.log(`\n⚠️ No se logró pasar la validación después de ${MAX_GENERATION_ATTEMPTS} intentos. Se guardará con advertencia.`);
  return { fullResponse: lastResponse, passedQA: false };
}

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: false,
    slowMo: 300,
    args: [`--profile-directory=${PROFILE_DIRECTORY}`],
    viewport: { width: 1440, height: 900 },
  });

  try {
    const page = context.pages()[0] || (await context.newPage());

    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    if (page.url().includes('/sign-in')) {
      console.log('\nNo hay sesión activa. Iniciá sesión manualmente en la ventana que se abrió (esperando hasta 5 minutos)...\n');
      await page.waitForURL((url) => !url.toString().includes('/sign-in'), { timeout: 300000 });
      await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
    }

    console.log('Clicking "Enter Flow"...');
    await clickByText(page, 'Enter Flow');
    await page.waitForLoadState('networkidle').catch(() => {});

    console.log('Clicking "Assign Most Urgent Song"...');
    await clickByText(page, 'Assign Most Urgent Song');
    await page.waitForTimeout(2000);
    await page.waitForLoadState('networkidle').catch(() => {});

    console.log('Reading Survey Responses...');
    const surveyLines = await readSurveyResponses(page);
    if (surveyLines.length === 0) {
      throw new Error('No se encontraron respuestas de la encuesta en la página.');
    }
    const surveyText = surveyLines.join('\n');
    fs.writeFileSync(SURVEY_PATH, surveyText, 'utf-8');
    console.log(`Encuesta guardada en ${SURVEY_PATH}`);

    console.log('Leyendo Song ID...');
    const songId = await readSongId(page);
    if (!songId) {
      throw new Error('No se encontró el Song ID en la página.');
    }
    console.log(`Song ID: ${songId}`);

    console.log('Leyendo survey.txt...');
    const surveyContent = fs.readFileSync(SURVEY_PATH, 'utf-8');

    const { fullResponse, passedQA } = await generateSongWithSelfCorrection(surveyContent);

    const checklistIndex = fullResponse.search(/\*\*QA Checklist:\*\*/i);
    const lyricsContent = (checklistIndex === -1 ? fullResponse : fullResponse.slice(0, checklistIndex))
      .replace(/-{3,}\s*$/, '')
      .trim();

    const now = new Date();
    const dateStr = `${now.getMonth() + 1}.${String(now.getDate()).padStart(2, '0')}.${now.getFullYear()}`;
    const notesLine = `NOTES: ${dateStr}. Hector. PS0180. Letra + Suno. Song ID: ${songId}`;

    const warningBanner = passedQA
      ? ''
      : `⚠️ ADVERTENCIA: no pasó la validación después de ${MAX_GENERATION_ATTEMPTS} intentos. Revisar manualmente.\n\n`;

    const songContent = `${warningBanner}${lyricsContent}\n\n${notesLine}`;

    fs.writeFileSync(SONG_PATH, songContent, 'utf-8');
    console.log(`\nCanción guardada en ${SONG_PATH}`);

    console.log('\n--- Letra generada ---\n');
    console.log(fullResponse);
    console.log('\n-----------------------\n');

    spawn('notepad.exe', [SONG_PATH], { detached: true, stdio: 'ignore' }).unref();

    console.log(
      passedQA
        ? '✅ Listo. Revisá song.txt antes de continuar.'
        : '⚠️ Listo, pero con advertencia. Revisá song.txt cuidadosamente antes de continuar.'
    );
  } finally {
    await context.close();
  }
})().catch((err) => {
  console.error('Automation failed:', err);
  process.exit(1);
});
