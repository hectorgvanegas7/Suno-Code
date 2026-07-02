// Canción Eterna Flow — generation step.
// Assigns the most urgent song, reads the survey and saves it to survey.txt,
// then generates the song lyrics with Claude and saves title+lyrics to
// song.txt (title on the first line, blank line, then the lyrics). Does
// not touch the Flow UI fields, does not screenshot, does not submit
// anything — that's all done manually now.
//
// ─── OPTIMIZACIÓN DE RECURSOS (añadido) ──────────────────────────────────────
// Esta versión NO cambia nada del comportamiento de generación. Solo agrega
// higiene de recursos para que abrir/cerrar Chrome en cada corrida no deje
// basura ni procesos colgados:
//   1. Flags de Chrome más livianos (menos escritura a disco, menos pings).
//   2. Caché del perfil con tope de tamaño + limpieza automática al terminar
//      (solo borra caché HTTP/GPU, NUNCA cookies ni sesión — el login se mantiene).
//   3. Cierre garantizado del navegador ante Ctrl+C, crash o señal del SO,
//      para que nunca quede un chrome.exe huérfano comiendo RAM.
// ─────────────────────────────────────────────────────────────────────────────
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { clickByText } = require('./lib/playwright-helpers');
const { enterFlowAndEnsureAssignment } = require('./lib/flow-helpers');
const pipelineState = require('./lib/pipeline-state');

const USER_DATA_DIR = 'C:\\Users\\hecto\\AppData\\Local\\ChromeAutomationProfile';
const PROFILE_DIRECTORY = 'Profile 1';
const TARGET_URL = 'https://cancioneterna.com/artists/flow';
const SURVEY_PATH = path.join(__dirname, 'survey.txt');
const SONG_PATH = path.join(__dirname, 'song.txt');

// ─── CONFIG DE RECURSOS ───────────────────────────────────────────────────────
// Tope de caché en disco que Chrome puede usar (100 MB). Evita crecimiento sin fin.
const DISK_CACHE_SIZE_BYTES = 100 * 1024 * 1024;
// Si el perfil supera este tamaño, se limpia la caché al terminar la corrida.
const CACHE_CLEANUP_THRESHOLD_MB = 200;

// Flags estándar de automatización: todos seguros para Flow, Suno y el login.
// No tocan render visible, GPU ni audio; solo reducen escritura a disco y ruido.
const CHROME_ARGS = [
  `--profile-directory=${PROFILE_DIRECTORY}`,
  `--disk-cache-size=${DISK_CACHE_SIZE_BYTES}`,
  '--disable-dev-shm-usage',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',            // no escribe volcados de crash a disco
  '--disable-component-update',    // no descarga componentes en silencio
  '--disable-features=Translate',
  '--no-default-browser-check',
  '--no-first-run',
  '--metrics-recording-only',
];

// Subcarpetas que SOLO contienen caché (seguro borrarlas, no afectan el login).
// NUNCA se toca: Cookies, Login Data, Local Storage, Session Storage, IndexedDB.
const CACHE_SUBDIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GrShaderCache',
  'ShaderCache',
  'component_crx_cache',
];

function getDirSizeBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      total += entry.isDirectory() ? getDirSizeBytes(full) : fs.statSync(full).size;
    } catch {
      /* archivo bloqueado o desaparecido — ignorar */
    }
  }
  return total;
}

// Borra solo la caché si el perfil pasó el umbral. Se llama DESPUÉS de cerrar
// el navegador, cuando los archivos ya no están bloqueados.
function cleanProfileCacheIfNeeded() {
  const profileRoot = path.join(USER_DATA_DIR, PROFILE_DIRECTORY);
  const sizeMB = getDirSizeBytes(profileRoot) / (1024 * 1024);
  console.log(`\nTamaño del perfil de Chrome: ${sizeMB.toFixed(1)} MB`);

  if (sizeMB < CACHE_CLEANUP_THRESHOLD_MB) {
    console.log(`(Por debajo de ${CACHE_CLEANUP_THRESHOLD_MB} MB — no se limpia nada.)`);
    return;
  }

  let freedBytes = 0;
  // La caché de shaders/GPU puede vivir tanto en el perfil como en la raíz.
  const roots = [profileRoot, USER_DATA_DIR];
  for (const root of roots) {
    for (const sub of CACHE_SUBDIRS) {
      const target = path.join(root, sub);
      try {
        const before = getDirSizeBytes(target);
        if (before === 0) continue;
        fs.rmSync(target, { recursive: true, force: true });
        freedBytes += before;
      } catch {
        /* ignorar lo que no se pueda borrar */
      }
    }
  }
  console.log(`Caché limpiada: ${(freedBytes / (1024 * 1024)).toFixed(1)} MB liberados. (Login y sesión intactos.)`);
}

const SYSTEM_PROMPT = `You are a Grammy Award-winning songwriter for Canción Eterna — a Christian Music Production company similar to SongFinch but for the Christian niche. You write deeply personal, emotionally powerful songs based on specific survey details provided by the user.

Every song you write feels like it was written BY the survey filler TO the specific person it's intended for. The person who hears the song should feel like only someone who truly knows them could have written it.

You are a storyteller, not a survey transcriber. You use all — or as much as possible — of the exact words, phrases and details from the survey, but you give them life: show through scene and action, don't just report facts. Memories, specific scenes, and concrete details are ALWAYS better than metaphors or poetry that could apply to anyone. You never invent details. The survey is your only source of truth.

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
- The FIRST WORD of the FIRST LINE is always the first name of the person the song is for (see PHONETIC RE-SPELLING and MULTIPLE RECIPIENTS below for exceptions on exact spelling/placement)
- The person's name appears EXACTLY ONCE per chorus — only in the first line, never repeated
- The purpose of the chorus is to make the person cry and feel the full emotion of the survey
- Chorus 1 and Chorus 2 are NEVER identical — they must differ in structure, angle, and emotional tone. Change or deepen at least one or two lines, don't just reshuffle the same ideas
- Chorus 1 = gratitude or love from the dedicator's perspective
- Chorus 2 = admiration, pride, or a deeper emotional declaration
- If the survey is from a parent dedicating to a child, open the chorus with "[Name], mamá" or "[Name], papá" instead of just the name

**Verse 2**
- NEVER list qualities ("the most patient, the most faithful, the most…") — this is an automatic failure
- ALWAYS narrate a specific scene or moment with concrete detail from the survey
- Show the person's character through action, not adjectives
- This is the heart of the story: a challenge, a season of growth, a hard or meaningful moment — it should make the next chorus hit harder
- Example (incorrect): "You are the most dedicated, patient and loving person"
- Example (correct): "Even after a long shift you'd come home and still make us laugh"

**Bridge**
- The most vulnerable, intimate moment in the entire song
- Use the single most specific and emotionally powerful detail from the survey — ideally close to the survey's own words, beautifully reshaped
- If the survey mentions a birth, a loss, a move, a sacrifice — this is where it lives
- NEVER use generic adjectives: "your essence", "your goodness", "your strength"
- The goal: make the listener cry because of how specific and real it is, not because it sounds pretty

**Outro**
- Ground the song in the special message and grateful love — everything connects here, and it's where people cry
- Close with a strong promise ("I will love you forever", "you are my always") — vary the wording, don't reuse the same closing line song after song
- Simple, powerful, emotionally conclusive
- Exactly 4 lines — never add a 5th "to make it close well"

### MULTIPLE RECIPIENTS

If the survey names more than one person to dedicate the song to:
- NEVER list all the names together in one line — it kills the flow and the audio
- Always open generally (shared love, origin, or blessing) BEFORE naming anyone specifically
- Each name gets its own lyrical space — one emotion, image, or truth — with balanced emotional weight. No recipient gets the "best" line
- 2 names: Chorus 1 = Name 1, Chorus 2 = Name 2 — never both in the same chorus
- 3 names: Chorus 1 = Name 1, Verse 2 = Name 2, Chorus 2 = Name 3
- 4 names: each name appears in line 3 of its section (Verse 1 → Name 1, Chorus 1 → Name 2, Verse 2 → Name 3, Chorus 2 → Name 4)
- 5+ names: stagger precisely, no filler. Final test: would every recipient feel equally loved if they listened just for their part?

### POINT OF VIEW

- The song keeps ONE single point of view from start to finish — never switch perspective mid-song
- Dedicated to someone: always speak directly TO that person
- "For myself" surveys (the customer dedicating the song to themselves): the ENTIRE song is in GOD'S VOICE speaking to the customer — comfort, love, companionship, hope. Never mix POV in this case

### PHONETIC RE-SPELLING FOR SUNO

Suno sometimes mispronounces names. You may slightly modify how a name is SPELLED in the lyrics so Suno sings it correctly, as long as the real sound is preserved. Official examples:
- Desiree → "Dez-ray" | Aria → "Arya" | Gabby → "Gab bee" | Shea → "Shay" | Pierre → "Pee-air" | Stephen → "Stefen"
- If a name starting with a vowel gets a phantom "H" in Suno (e.g. "Alma" → "Halma"), propose a respelling that keeps the sound (e.g. "Aalma" or "Al-ma") without changing the real name
- Never spell a name out acrostic-style ("MARIA - M de mi amor, A de...") — it sounds forced and breaks the emotion
- Always flag any respelling you used in the **Advertencias** field of the response so it can be reviewed before sending to Suno

### GENERAL RULES

1. **No quality lists.** "Your patience, your dedication, your love" = automatic regeneration. Every quality must be shown through a scene or action, not explained.

2. **Nothing invented.** Only use what is explicitly in the survey. If it's not there, don't write it.

3. **Consistent address form (Spanish).** Use tú, usted, or vos based on the survey — never mix. This includes imperative phrases (e.g. "no tardes" = tú / "no tarde" = usted / "no tardés" = vos). Verify every single line including the Outro.

4. **Voice = who dedicates, not who receives.** If a wife dedicates to her husband, the voice is feminine. Always check the "who is dedicating" field.

5. **Numbers, months and acronyms always written in full.** Never digits: "two thousand eight" not "2008", "veinte años" not "20 años". Full months ("Febrero" not "Feb", "Enero" not "En"). Full place names/acronyms ("Nueva York" not "NY", "Estados Unidos" not "EEUU").

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

16. **Rhyme with judgment, not at the cost of feeling.** Emotion and story always come first. Don't force a rhyme that weakens the meaning.

17. **Keep line lengths and syllable counts even within a section.** This helps Suno's phrasing enormously — avoid one line running much longer than the rest.

18. **Avoid overused phrases.** Don't repeat clichés like "Dios me dio a ti" song after song — find a fresh way to say it each time, especially for blended-family stories.

### SUNO STYLE PROMPT — MANDATORY RULE

**ALWAYS end every Suno style prompt with:**
> \`Latin American Spanish, neutral accent, seseo\`

This is non-negotiable on every single song. Without it, Suno defaults to a Castilian Spanish accent (z/c pronounced as "th"), which sounds wrong for Latin American clients.

Pick the template below that matches the survey's real energy (not everything is a party) and adapt instruments/mood as needed — always keep the mandatory suffix:

> Balada: \`Balada, tempo moderado, piano suave y cuerdas cálidas, acompañamiento emocional y delicado, voz expresiva y cercana llena de amor y gratitud, sonido íntimo y sentimental, love ballad, emotional, heartfelt, Latin American Spanish, neutral accent, seseo\`

> Norteño: \`Música norteña, tempo medio a lento, acordeón melódico y bajo sexto tradicional, batería sutil, voz clara y sincera, mensaje de fe y amor verdadero, norteño, emotional, regional mexicano, warm accordion, Latin American Spanish, neutral accent, seseo\`

> Salsa: \`Salsa romántica, tempo medio, percusión latina suave, piano salsero, bajo cálido y metales ligeros, voz clara y emotiva, gratitud y bendición, bailable pero respetuoso, salsa, joyful, uplifting, faith-centered, Latin American Spanish, neutral accent, seseo\`

> Bachata: \`Bachata romántica, tempo medio-lento, guitarras bachateras suaves, percusión ligera, voz sentimental y cercana, amor profundo y fe, íntimo y esperanzador, bachata, emotional, heartfelt, Latin American Spanish, neutral accent, seseo\`

> Reggaetón: \`Reggaetón suave, tempo medio, beat limpio y controlado, bajo no agresivo, voz melódica no explícita, enfoque en mensaje y emoción, gratitud y familia, reggaeton, uplifting, modern, faith-based, Latin American Spanish, neutral accent, seseo\`

> Worship/Adoración: \`Beautiful christian worship, tempo moderado 80-90 BPM, piano hermoso con cuerdas suaves, progresión prayerful, voz apasionada y soulful, uplifting and inspiring, major chords, Latin American Spanish, neutral accent, seseo\`

> Mariachi/Ranchera: \`Traditional Mexican Mariachi Ranchera, powerful and commanding, deep emotional delivery, rich vibrato, trumpets, vihuela, guitarrón, passionate, nostalgic and heartfelt, authentic regional mexicano, Latin American Spanish, neutral accent, seseo\`

> Pop cristiano: \`Pop cristiano, guitarra acústica, coro emotivo, voz masculina, uplifting, worship-inspired, Latin American Spanish, neutral accent, seseo\`

### AUTO-QA CHECKLIST — RUN BEFORE DELIVERING

Verify every item internally before showing the result — go line by line through the **QA Checklist** block defined in the RESPONSE FORMAT section below and confirm each one is a real ✓ against the lyrics you just wrote, not assumed. If any item fails, regenerate. Maximum 3 attempts.
If still failing after 3 attempts, deliver with: ⚠️ REVISAR MANUALMENTE: [list of failed items]

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
- Números, meses y siglas completos: ✓/✗
- Título no cantable: ✓/✗
- Sin guiones largos / punto y coma / dos puntos: ✓/✗
- Sin líneas consecutivas con misma palabra inicial: ✓/✗
- Todas las líneas con sentido lógico: ✓/✗
- Estilo Suno incluye seseo + acento latinoamericano: ✓/✗
- Sin diálogos citados textualmente de la encuesta: ✓/✗
- Destinatarios múltiples balanceados (si aplica): ✓/✗
- POV consistente / voz de Dios si es "para mí": ✓/✗
- Sin acróstico en el nombre: ✓/✗

**Advertencias:** [any phonetic re-spelling used, or other concerns for manual review — write "Ninguna" if none]`;

async function readSongId(page) {
  return page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('span.font-semibold'));
    const label = labels.find((el) => el.textContent.trim() === 'Song ID:');
    const value = label && label.nextElementSibling;
    return value ? value.textContent.trim() : null;
  });
}

async function readRedoFeedback(page) {
  return page.evaluate(() => {
    const banner = document.querySelector('div.bg-orange-50.border-orange-200');
    if (!banner) return null;
    const feedbackBox = banner.querySelector('div.whitespace-pre-wrap');
    return feedbackBox ? feedbackBox.textContent.trim() : null;
  });
}

async function readSurveyResponses(page) {
  // #lyrics renders from server HTML; survey data is fetched via async API call that
  // completes slightly after. Wait for the concrete DOM signal instead of a blind timeout.
  try {
    await page.waitForSelector('div.bg-gray-50.border.rounded.p-3.text-sm.space-y-1 > div', {
      timeout: 15000,
    });
  } catch {
    return []; // let line 811 throw the descriptive error
  }
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
      model: 'claude-sonnet-5',
      max_tokens: 8192,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages: [{ role: 'user', content: surveyText }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  if (data.usage) {
    const u = data.usage;
    console.log(
      `  usage: input=${u.input_tokens} cache_creation=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0} output=${u.output_tokens}`
    );
  }
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

  // Extraer nombre(s) del/de los dedicado(s) desde la encuesta. El campo puede
  // tener uno o varios nombres con relleno alrededor (ej. "Mis hijos Christopher
  // y Soraya."), así que filtramos las palabras de relleno comunes en vez de
  // asumir que la primera palabra es el nombre — eso rompía por completo la
  // validación en encuestas multi-destinatario (ver LESSONS.md).
  const nameFieldRaw =
    (surveyText.match(/What['']s their name\??:\s*([^\n]+)/i) ||
      surveyText.match(/Nombre[^:]*:\s*([^\n]+)/i) || [])[1] || '';
  const NAME_FIELD_FILLER_WORDS = new Set([
    'mis', 'mi', 'su', 'sus', 'el', 'la', 'los', 'las', 'de', 'del',
    'hijo', 'hija', 'hijos', 'hijas', 'y', 'and', 'e',
  ]);
  const firstNames = [
    ...new Set(
      nameFieldRaw
        .replace(/[.,]/g, ' ')
        .split(/\s+/)
        .map((w) => w.toLowerCase())
        .filter((w) => w.length > 1 && !NAME_FIELD_FILLER_WORDS.has(w))
    ),
  ];

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
        if (!matchedName) {
          failures.push(
            `[${sec}] primera palabra es "${firstWord}", debe ser uno de: ${firstNames.join(', ')} (o una variante fonética que empiece con la misma letra)`
          );
        } else {
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
    if (leakedName) {
      failures.push(`[Verse 1] contiene el nombre "${leakedName}" — debe estar ausente`);
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
      if (trimmed.includes('✗') || (!trimmed.includes('✓') && !isConditionalNA && /[a-záéíóúñ]/i.test(trimmed))) {
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
// ─── FIN VALIDACIÓN ESTRUCTURAL DURA ──────────────────────────────────────────

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

function buildRedoUserMessage(surveyContent, currentTitle, currentLyrics, feedbackText) {
  return `Here is the survey for this song:

${surveyContent}

This song was already written and submitted to Quality Control, which rejected it and sent it back for a redo.

Current title: ${currentTitle}

Current lyrics on file:

${currentLyrics}

Exact QA feedback explaining what's wrong:

${feedbackText}

Your task has two parts:

1. FIRST — apply the fix described in the QA feedback precisely.

2. SECOND — analyze the full lyrics against the survey and improve them to be a 9-10/10:
- Is any important survey detail missing?
- Does the Bridge use the most vulnerable moment available in the survey?
- Does Verse 2 narrate a concrete scene, or does it just list qualities?
- Does the Chorus actually move someone to tears, or is it generic?
- Does the song sound like it was written by the person who dedicated it?

Do NOT invent details that are not in the survey. Do NOT change parts of the lyrics that are already good and unrelated to the feedback or the improvement points above.

Run the full validation checklist on the improved lyrics before delivering. If anything fails, fix it before continuing.`;
}

const MAX_GENERATION_ATTEMPTS = 3;

async function generateSongWithSelfCorrection(surveyContent, baseUserMessageOverride) {
  const baseUserMessage = baseUserMessageOverride || `Here is the survey for this song:\n\n${surveyContent}`;
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

// ─── CIERRE GARANTIZADO DEL NAVEGADOR ─────────────────────────────────────────
// Mantiene una referencia global al contexto para poder cerrarlo ante cualquier
// salida (Ctrl+C, kill, excepción), y así nunca dejar un chrome.exe huérfano.
let activeContext = null;
let isClosing = false;

async function safeCloseContext() {
  if (isClosing) return;
  isClosing = true;
  if (activeContext) {
    try {
      await activeContext.close();
    } catch {
      /* ya estaba cerrándose */
    }
    activeContext = null;
  }
}

// Ctrl+C y señales de terminación del SO
process.on('SIGINT', async () => {
  console.log('\nSeñal de interrupción recibida — cerrando Chrome limpiamente...');
  await safeCloseContext();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await safeCloseContext();
  process.exit(0);
});
// Excepción no atrapada: cerrar Chrome antes de morir
process.on('uncaughtException', async (err) => {
  console.error('Excepción no controlada:', err);
  await safeCloseContext();
  process.exit(1);
});
// ──────────────────────────────────────────────────────────────────────────────

(async () => {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',
    headless: false,
    slowMo: 200,
    args: CHROME_ARGS,
    viewport: { width: 1440, height: 900 },
  });
  activeContext = context;

  try {
    const page = context.pages()[0] || (await context.newPage());

    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

    if (page.url().includes('/sign-in')) {
      console.log('\nNo hay sesión activa. Iniciá sesión manualmente en la ventana que se abrió (esperando hasta 5 minutos)...\n');
      await page.waitForURL((url) => !url.toString().includes('/sign-in'), { timeout: 300000 });
      await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
    }

    console.log('Entrando al Flow y asegurando asignación activa...');
    const flowResult = await enterFlowAndEnsureAssignment(page, clickByText);
    if (flowResult.assigned === 'newly-assigned') {
      console.log('Se asignó la canción más urgente.');
    } else {
      console.log('Ya hay una asignación activa en curso, continuando con ella...');
    }

    // Ojo: el banner naranja (bg-orange-50/border-orange-200) NO es exclusivo de
    // REDO — el banner "Priority Delivery" usa exactamente las mismas clases y
    // no tiene feedback adentro. Por eso el estado REDO se determina por si
    // readRedoFeedback() efectivamente encuentra texto, no por el color del banner.
    const redoFeedback = await readRedoFeedback(page);
    const isRedo = redoFeedback !== null;

    let redoTitle = null;
    let redoLyrics = null;

    if (isRedo) {
      console.log('Detected REDO state (this song was already assigned and rejected by QC).');
      redoTitle = await page.locator('#title').inputValue();
      redoLyrics = await page.locator('#lyrics').inputValue();
    }

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

    const baseUserMessage = isRedo
      ? buildRedoUserMessage(surveyContent, redoTitle, redoLyrics, redoFeedback)
      : undefined;

    const { fullResponse, passedQA } = await generateSongWithSelfCorrection(surveyContent, baseUserMessage);

    // Si quedó razonamiento/preámbulo antes de "**Título:**" (ej. cuando se
    // agota MAX_GENERATION_ATTEMPTS y se guarda con advertencia), arrancar
    // desde ahí — nunca guardar ese texto en song.txt.
    const tituloIndex = fullResponse.search(/\*\*Título:\*\*/i);
    const responseFromTitulo = tituloIndex > 0 ? fullResponse.slice(tituloIndex) : fullResponse;

    const checklistIndex = responseFromTitulo.search(/\*\*QA Checklist:\*\*/i);
    const lyricsContent = (checklistIndex === -1 ? responseFromTitulo : responseFromTitulo.slice(0, checklistIndex))
      .replace(/-{3,}\s*$/, '')
      .trim();

    // Validación obligatoria antes de escribir: si la respuesta no tiene título ni
    // secciones, es truncación o chain-of-thought crudo — no guardar como song.txt
    // válido ni seguir hacia suno-fill.
    const writeCheck = validateContentForWrite(lyricsContent);
    if (!writeCheck.ok) {
      console.error('\n❌ VALIDACIÓN PRE-ESCRITURA FALLÓ — respuesta sin estructura mínima:');
      writeCheck.failures.forEach((f) => console.error(`  • ${f}`));
      console.error('   Pipeline detenido. Corré run.js de nuevo.');
      const d = new Date();
      const emergencyDate = `${d.getMonth() + 1}.${String(d.getDate()).padStart(2, '0')}.${d.getFullYear()}`;
      fs.writeFileSync(
        SONG_PATH,
        [
          '⚠️ ERROR CRÍTICO: la generación de letra falló. Corré run.js de nuevo.',
          '',
          `Causa: ${writeCheck.failures.join('; ')}`,
          '',
          `NOTES: ${emergencyDate}. Hector. PS0180. Letra + Suno. Song ID: ${songId}`,
        ].join('\n'),
        'utf-8'
      );
      throw new Error('Validación pre-escritura falló — respuesta corrupta o truncada.');
    }

    // Advertencias es el último campo de la respuesta — puede tener varias líneas
    // (ej. varios bullets), así que capturamos hasta el final en vez de una sola línea.
    const advertenciasMatch = fullResponse.match(/\*\*Advertencias:\*\*\s*([\s\S]+)/i);
    const advertencias = advertenciasMatch ? advertenciasMatch[1].trim() : null;
    const advertenciasLine =
      advertencias && !/^ninguna\.?$/i.test(advertencias) ? `**Advertencias:** ${advertencias}\n\n` : '';

    const now = new Date();
    const dateStr = `${now.getMonth() + 1}.${String(now.getDate()).padStart(2, '0')}.${now.getFullYear()}`;
    const notesLine = `NOTES: ${dateStr}. Hector. PS0180. Letra + Suno. Song ID: ${songId}`;

    const warningBanner = passedQA
      ? ''
      : `⚠️ ADVERTENCIA: no pasó la validación después de ${MAX_GENERATION_ATTEMPTS} intentos. Revisar manualmente.\n\n`;

    const songContent = `${warningBanner}${lyricsContent}\n\n${advertenciasLine}${notesLine}`;

    fs.writeFileSync(SONG_PATH, songContent, 'utf-8');
    console.log(`\nCanción guardada en ${SONG_PATH}`);

    // Registrar el estado del pipeline para que los scripts siguientes
    // (suno-fill, flow-submit, --done) sepan sobre qué canción están trabajando
    // y puedan detectar si se cruzó con otra (ver lib/pipeline-state.js).
    try {
      const tituloForState = extractField(fullResponse, 'Título');
      pipelineState.startNew({ songId, titulo: tituloForState, isRedo });
    } catch (e) {
      console.log('(No se pudo escribir state.json, no es crítico:', e.message, ')');
    }

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
    await safeCloseContext();
    // Higiene de disco: limpiar caché solo si el perfil creció demasiado.
    // Se hace acá, con el navegador ya cerrado, para no tocar archivos en uso.
    try {
      cleanProfileCacheIfNeeded();
    } catch (e) {
      console.log('No se pudo limpiar la caché (no es crítico):', e.message);
    }
  }
})().catch((err) => {
  console.error('Automation failed:', err);
  safeCloseContext().finally(() => process.exit(err.noSong ? 2 : 1));
});
