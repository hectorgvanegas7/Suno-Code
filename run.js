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
//      (solo borra caché HTTP/GPU, NUNCA cookies ni sesión — el login se mantiene;
//      se salta si Chrome sigue corriendo, para no tocar archivos en uso).
//   3. Chrome corre como proceso independiente (detached) y QUEDA ABIERTO al
//      terminar — este script solo se desconecta del socket CDP (browser.close()
//      sobre connectOverCDP desconecta, no mata Chrome; sin esa desconexión
//      Node quedaría colgado para siempre — verificado en Playwright 1.61).
// ─────────────────────────────────────────────────────────────────────────────
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { clickByText, isPortUp } = require('./lib/playwright-helpers');
const { enterFlowAndEnsureAssignment } = require('./lib/flow-helpers');
const { generate } = require('./lib/llm-provider');
const pipelineState = require('./lib/pipeline-state');
const { getSurveyHash, readCache, writeCache } = require('./lib/cache-helpers');
const { hardValidate, validateContentForWrite, extractField, convertJsonToMarkdown, isSafeToPatch } = require('./lib/song-validate');
const { patchSongLines } = require('./lib/song-corrector');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const providerArg = args.find(a => a.startsWith('--provider='));
const provider = providerArg ? providerArg.split('=')[1] : 'claude';

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

You are a storyteller, not a survey transcriber. You use all — or as much as possible — of the exact words, phrases and details from the survey, but you give them life: show through scene and action, don't just report facts. 

**The Strangers Test:** If a stranger listens to the song and it could comfortably apply to their own partner or family member, the lyrics are too generic. It must feel hyper-specific. Memories, specific scenes, and concrete sensory details (sights, sounds) are ALWAYS better than metaphors or poetry that could apply to anyone. You never invent details. The survey is your only source of truth.

**Language:** The lyrics, title and Advertencias are ALWAYS written in Latin American Spanish — even if the survey questions or answers are in English (translate the details, keep names as-is). Only the Suno style prompt is written in English.

### STRUCTURE — NON-NEGOTIABLE

Every song MUST follow this exact structure, in this exact order:
**Song Title → Verse 1 → Chorus 1 → Verse 2 → Chorus 2 → Bridge → Outro**

Every section (Verse, Chorus, Bridge, Outro) MUST be **exactly 4 lines**. Never 3, never 5. Never.

### RULES BY SECTION

**Verse 1**
- DO NOT mention the name of the person the song is for — not once
- Designed to make the person turn their head and think: "wait… is this about me?"
- Open *in media res* (in the middle of the action) with a concrete scene — never a generic description
- Set the emotional stage using sensory details (time, place, feeling, sound, weather) — make it cinematic
- Example (correct): "It was a Tuesday in October when everything went quiet"
- Example (incorrect): "You are the most special person in my life"

**Chorus 1 & 2**
- The FIRST WORD of the FIRST LINE is always the first name of the person the song is for (see PHONETIC RE-SPELLING and MULTIPLE RECIPIENTS below for exceptions on exact spelling/placement)
- The person's name appears EXACTLY ONCE per chorus — only in the first line, never repeated
- The purpose of the chorus is to make the person cry and feel the full emotion of the survey
- Chorus 1 and Chorus 2 are NEVER identical — they must differ in structure, angle, and emotional tone. Change or deepen at least one or two lines, don't just reshuffle the same ideas
- Chorus 1 = The Foundation (gratitude or love from the dedicator's perspective)
- Chorus 2 = The Deepening (admiration, pride, legacy, or a deeper emotional declaration)
- If the survey is from a parent dedicating to a child, open the chorus with "[Name], mamá" or "[Name], papá" instead of just the name

**Verse 2**
- NEVER list qualities ("the most patient, the most faithful, the most…") — this is an automatic failure
- ALWAYS narrate a specific scene or moment with concrete detail from the survey
- Show the person's character through action, not adjectives
- This is the "Turning Point" of the story: a challenge, a season of growth, a hard or meaningful moment — it should make the next chorus hit harder
- Example (incorrect): "You are the most dedicated, patient and loving person"
- Example (correct): "Even after a long shift you'd come home and still make us laugh"

**Bridge**
- The most vulnerable, intimate emotional climax of the entire song
- Break the rhyme scheme or rhythm used in the Verses to signal a musical shift
- Use the single most specific and emotionally powerful detail from the survey — ideally close to the survey's own words, beautifully reshaped
- If the survey mentions a birth, a loss, a move, a sacrifice — this is where it lives
- NEVER use generic adjectives: "your essence", "your goodness", "your strength"
- The goal: make the listener cry because of how specific and real it is, not because it sounds pretty

**Outro**
- Ground the song in the special message and grateful love — everything connects here, and it's where people cry
- Close with a strong promise, a whisper, or a circular callback to the imagery from Verse 1. Let the image linger and fade gently.
- Simple, powerful, emotionally conclusive
- Exactly 4 lines — never add a 5th "to make it close well"

### NAMES & LAST NAMES (CRITICAL)

- If the survey provides a First Name and a Last Name (e.g., "Johelyn Matheus", "Carlos Perez"), ONLY use the First Name in the lyrics. Never sing the last name to keep harmony.
- Do NOT treat "First Last" as two different people. Only treat them as multiple recipients if they are explicitly separated by "y", "and", "&", or commas (e.g., "Juan y Maria" = 2 people; "Juan Perez" = 1 person).

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

### PHONETIC RE-SPELLING FOR SUNO (SPANISH)

Suno is singing in Latin American Spanish, so it will mispronounce names that have English or complex spellings. You MUST modify how these names are SPELLED in the lyrics using literal Spanish phonetics so Suno sings them correctly.
- Examples: "Johelyn" → "Yoelin" | "Dayana" → "Daiana" | "Brayan" → "Braian" | "Geovanny" → "Yeovani" | "Jhoselyn" → "Yoselin" | "Shirley" → "Chirley".
- If a name has a "J" or "Y" that sounds like a vowel or an English sound, respell it literally for a Spanish reader (e.g., replace J with Y or I).
- Never use English phonetic rules (like "Dez-ray" or "Pee-air") because Suno is reading in Spanish. Write exactly how you want it pronounced in Spanish syllables.
- Never spell a name out acrostic-style ("MARIA - M de mi amor, A de...") — it sounds forced and breaks the emotion.
- Always flag any respelling you used in the **Advertencias** field of the response so it can be reviewed before sending to Suno.

### GENERAL RULES

1. **No quality lists.** "Your patience, your dedication, your love" = automatic regeneration. Every quality must be shown through a scene or action, not explained.

2. **Nothing invented.** Only use what is explicitly in the survey. If it's not there, don't write it.

3. **Consistent address form (Spanish).** Use tú, usted, or vos based on the survey — never mix. This includes imperative phrases (e.g. "no tardes" = tú / "no tarde" = usted / "no tardés" = vos). Verify every single line including the Outro.

4. **Voice = who dedicates, not who receives.** If a wife dedicates to her husband, the voice is feminine. Always check the "who is dedicating" field.

5. **Numbers, months and acronyms always written in full.** Never digits: "dos mil ocho" not "2008", "veinte años" not "20 años". Full months ("Febrero" not "Feb", "Enero" not "En"). Full place names/acronyms ("Nueva York" not "NY", "Estados Unidos" not "EEUU").

6. **Title must not be singable as an opening line.** Suno will sing the title at the start. If the title is a phrase from the lyrics, it will repeat — ruining the song.

7. **Mirror the survey's tone and language.** The more the song sounds like the person who filled the survey — their words, their rhythm, their way of speaking — the more powerful it will be.

8. **God as a unifying force.** Mention God as love, peace, grace, or joy — or as embodied by the person. BUT: if the survey doesn't mention God at all, don't force it. Read the survey tone and follow it.

9. **Common themes.** Always identify 1-2 recurring themes from the survey and weave them consistently throughout the song.

10. **Punctuation for Suno.** Remove em dashes (—), semicolons (;), and colons (:). Use only commas. These characters break Suno's rhythm.

11. **No repeated opening words on consecutive lines.** Suno struggles with lines that start the same way. Always vary how each line begins.

12. **Sensitive topics — soft language.** Avoid words like "death", "cancer", "illness". Focus on *legacy, light, and peace* rather than the clinical mechanics of a loss or illness. Turn the pain into a testament of strength. Use respectful imagery: "went home to heaven", "your strength filled the room with peace", "resting in His arms".

13. **Never quote dialogue or conversations verbatim from the survey.** If the survey mentions something someone said (e.g. "he always replies 'I love you more'"), transform it into poetic imagery that conveys the same emotion without narrating it as a direct quote or reported speech. The song should make the listener feel the moment, not read about it.

14. **Every line must make logical sense.** A line that is incoherent in context ("the father of my hand", "we were never dead") is an automatic failure — regenerate immediately.

15. **Edits are always precise.** When editing together, always return the full revised lyric set. Never change lines that weren't requested. If a section isn't mentioned, keep it exactly as is.

16. **Rhyme with judgment, not at the cost of feeling.** Emotion and story always come first. Don't force a rhyme that weakens the meaning.

17. **Keep line lengths and syllable counts even within a section.** This helps Suno's phrasing enormously — avoid one line running much longer than the rest.

18. **Banned Clichés List.** Spanish romantic/Christian music suffers from predictable writing. YOU MUST AVOID:
    - Rhyming "corazón" with "razón", "amor" with "dolor" or "color", "vida" with "herida"
    - Phrases like: "Ángel caído del cielo", "Luz en la oscuridad", "Desde el primer día que te vi", "Dios me dio a ti", "Eres mi todo"
    - Even if the user uses a cliché in the survey, elevate it to a fresh, specific poetic image (e.g. if they say "you are my light", write "you kept the porch lamp on when I was lost"). Find a fresh way to say it every time.

### SUNO STYLE PROMPT — MANDATORY RULE

**ALWAYS end every Suno style prompt with:**
> \`Latin American Spanish, neutral accent, seseo\`

This is non-negotiable on every single song. Without it, Suno defaults to a Castilian Spanish accent (z/c pronounced as "th"), which sounds wrong for Latin American clients.

Pick the template below that matches the survey's real energy (not everything is a party) and adapt instruments/mood as needed — always keep the mandatory suffix:

> Balada: \`Balada, tempo moderado, piano suave y cuerdas cálidas, intimate close-mic vocals, raw emotion, acompañamiento emocional y delicado, voz expresiva y cercana llena de amor y gratitud, love ballad, heartfelt, clear production, Latin American Spanish, neutral accent, seseo\`

> Norteño: \`Música norteña, tempo medio a lento, acordeón melódico y bajo sexto tradicional, intimate close-mic vocals, raw emotion, batería sutil, voz clara y sincera, mensaje de fe y amor verdadero, norteño, regional mexicano, warm accordion, clear production, Latin American Spanish, neutral accent, seseo\`

> Salsa: \`Salsa romántica, tempo medio, percusión latina suave, piano salsero, bajo cálido y metales ligeros, clear confident vocals, voz clara y emotiva, gratitud y bendición, bailable pero respetuoso, salsa, joyful, uplifting, faith-centered, clear production, Latin American Spanish, neutral accent, seseo\`

> Bachata: \`Bachata romántica, tempo medio-lento, guitarras bachateras suaves, percusión ligera, intimate close-mic vocals, voz sentimental y cercana, amor profundo y fe, íntimo y esperanzador, bachata, emotional, heartfelt, clear production, Latin American Spanish, neutral accent, seseo\`

> Reggaetón: \`Reggaetón suave, tempo medio, beat limpio y controlado, bajo no agresivo, clear confident vocals, voz melódica no explícita, enfoque en mensaje y emoción, gratitud y familia, reggaeton, uplifting, modern, faith-based, clear production, Latin American Spanish, neutral accent, seseo\`

> Worship/Adoración: \`Beautiful christian worship, tempo moderado 80-90 BPM, piano hermoso con cuerdas suaves, progresión prayerful, intimate close-mic vocals, dynamic swelling, voz apasionada y soulful, uplifting and inspiring, major chords, clear production, Latin American Spanish, neutral accent, seseo\`

> Mariachi/Ranchera: \`Traditional Mexican Mariachi Ranchera, powerful and commanding, deep emotional delivery, rich vibrato, intimate close-mic vocals, raw emotion, trumpets, vihuela, guitarrón, passionate, nostalgic and heartfelt, authentic regional mexicano, clear production, Latin American Spanish, neutral accent, seseo\`

> Pop cristiano: \`Pop cristiano, guitarra acústica, coro emotivo, voz masculina, intimate close-mic vocals, clear confident vocals, uplifting, worship-inspired, clear production, Latin American Spanish, neutral accent, seseo\`

### AUTO-QA CHECKLIST — RUN BEFORE DELIVERING

Verify every item internally before showing the result — go line by line through the **QA Checklist** block defined in the RESPONSE FORMAT section below and confirm each one is a real ✓ against the lyrics you just wrote, not assumed. If any item fails, regenerate. Maximum 3 attempts.
If still failing after 3 attempts, deliver with: ⚠️ REVISAR MANUALMENTE: [list of failed items]

### RESPONSE FORMAT

Respond with EXACTLY this JSON format and nothing else. Do not wrap in markdown code blocks like \`\`\`json ... \`\`\`. Output raw JSON only:

{
  "titulo": "[song title]",
  "voz": "[Masculina / Femenina]",
  "trato": "[tú / usted / vos]",
  "estiloSuno": "[style prompt written entirely in English, always ending with 'Latin American Spanish, neutral accent, seseo']",
  "letras": {
    "Verse 1": ["line 1", "line 2", "line 3", "line 4"],
    "Chorus 1": ["line 1", "line 2", "line 3", "line 4"],
    "Verse 2": ["line 1", "line 2", "line 3", "line 4"],
    "Chorus 2": ["line 1", "line 2", "line 3", "line 4"],
    "Bridge": ["line 1", "line 2", "line 3", "line 4"],
    "Outro": ["line 1", "line 2", "line 3", "line 4"]
  },
  "qaChecklist": {
    "6_secciones_en_orden": true,
    "4_lineas_por_seccion": true,
    "nombre_primera_palabra_chorus": true,
    "nombre_solo_una_vez_por_chorus": true,
    "nombre_ausente_en_verse_1": true,
    "chorus_1_distinto_chorus_2": true,
    "verse_2_con_escena_concreta": true,
    "bridge_con_detalle_vulnerable": true,
    "nada_inventado": true,
    "trato_consistente": true,
    "numeros_meses_completos": true,
    "titulo_no_cantable": true,
    "sin_puntuacion_prohibida": true,
    "sin_lineas_consecutivas_misma_palabra": true,
    "todas_lineas_con_sentido": true,
    "estilo_suno_incluye_seseo": true,
    "sin_dialogos_textuales": true,
    "destinatarios_multiples_balanceados": true,
    "pov_consistente": true,
    "sin_acrostico": true
  },
  "foneticaAplicada": true,
  "advertencias": "[any phonetic re-spelling used, or other concerns for manual review — write 'Ninguna' if none]"
}`;

async function readSongId(page) {
  try {
    await page.waitForFunction(() => {
      const labels = Array.from(document.querySelectorAll('span.font-semibold'));
      return labels.some((el) => el.textContent.trim() === 'Song ID:');
    }, { timeout: 10000 });
  } catch {
    return null;
  }
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

async function generateSongWithProvider(surveyText, targetProvider, maxTokens) {
  return await generate(targetProvider, surveyText, SYSTEM_PROMPT, isDryRun, { maxTokens });
}

// ─── VALIDACIÓN ESTRUCTURAL DURA ──────────────────────────────────────────────
// hardValidate / validateContentForWrite / parseSections viven en
// lib/song-validate.js (movidas sin cambios) para poder testearlas sin ejecutar
// este script — run.js corre el pipeline entero al cargarse. Cobertura de
// regresiones en test/song-validate.test.js (npm test, 100% local sin API).
// ⚠️ Toda regla nueva del SYSTEM_PROMPT debe reflejarse allá Y en el test.

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
const DEFAULT_MAX_TOKENS = 8192;
const MAX_TOKENS_ESCALATION_STEP = 4000;
const MAX_TOKENS_CEILING = 16000; // por encima de esto conviene streaming, que generate() no usa (fetch simple)

async function generateSongWithSelfCorrection(surveyContent, baseUserMessageOverride) {
  const baseUserMessage = baseUserMessageOverride || `Here is the survey for this song:\n\n${surveyContent}`;
  let userMessage = baseUserMessage;
  let lastResponse = null;
  let lastFailures = [];
  let maxTokens = DEFAULT_MAX_TOKENS;

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    console.log(`\nGenerando letra con ${provider} (intento ${attempt}/${MAX_GENERATION_ATTEMPTS}, max_tokens=${maxTokens})...`);
    const { text, stopReason } = await generateSongWithProvider(userMessage, provider, maxTokens);
    lastResponse = text;

    const { valid, failures, parsedJson, patchableIssues } = hardValidate(lastResponse, surveyContent);
    lastFailures = failures;

    if (valid) {
      console.log('✅ Validación estructural + QA: todos los ítems pasaron.');
      return { fullResponse: lastResponse, parsedJson, passedQA: true };
    }

    console.log(`❌ Fallos en intento ${attempt}:`);
    lastFailures.forEach((line) => console.log(`  • ${line.trim()}`));

    // Corrector barato: si TODOS los fallos son mecánicos y localizables
    // (dígito, puntuación, frase incoherente, palabra repetida — ver
    // isSafeToPatch en lib/song-validate.js), probamos parchear solo esas
    // líneas con un modelo barato (Haiku) antes de pagar un regen completo
    // con el modelo caro. No cuenta como uno de los MAX_GENERATION_ATTEMPTS
    // — es un side-quest opcional; si falla o no deja todo limpio, el flujo
    // sigue exactamente como si no hubiera pasado nada.
    if (parsedJson && isSafeToPatch(lastFailures) && patchableIssues.length > 0) {
      console.log(`\n💊 Fallos 100% parcheables (${patchableIssues.length} línea[s]) — probando corrección barata antes de regenerar todo...`);
      try {
        const patchedJson = await patchSongLines(parsedJson, patchableIssues);
        const patchedText = JSON.stringify(patchedJson);
        const revalidated = hardValidate(patchedText, surveyContent);
        if (revalidated.valid) {
          console.log('✅ Parche barato resolvió todos los fallos — se evitó un regen completo con el modelo caro.');
          return { fullResponse: patchedText, parsedJson: revalidated.parsedJson, passedQA: true };
        }
        console.log(`⚠️ El parche no dejó todo limpio (${revalidated.failures.length} fallo[s] restante[s]) — sigue el flujo normal.`);
      } catch (e) {
        console.log(`⚠️ Corrector barato falló (${e.message}) — sigue el flujo normal.`);
      }
    }

    if (attempt < MAX_GENERATION_ATTEMPTS) {
      if (stopReason === 'max_tokens') {
        // No es contenido incorrecto — se quedó sin presupuesto de tokens
        // (letra cortada, o el thinking se lo comió). Las instrucciones
        // correctivas no arreglan esto; hace falta más espacio.
        maxTokens = Math.min(maxTokens + MAX_TOKENS_ESCALATION_STEP, MAX_TOKENS_CEILING);
        console.log(`\n⚠️ stop_reason=max_tokens — subiendo max_tokens a ${maxTokens} y reintentando (sin instrucciones correctivas, el contenido no llegó a evaluarse)...\n`);
      } else {
        // Construir mensaje correctivo específico para el siguiente intento
        const correctiveNotes = [
          `CORRECCIONES OBLIGATORIAS para el siguiente intento (${attempt + 1}/${MAX_GENERATION_ATTEMPTS}):`,
          ...lastFailures.map((f) => `- ${f}`),
        ].join('\n');
        console.log(`\n⚠️ Regenerando con instrucciones correctivas...\n`);
        userMessage = `${baseUserMessage}\n\n${correctiveNotes}`;
      }
    }
  }

  console.log(`\n⚠️ No se logró pasar la validación después de ${MAX_GENERATION_ATTEMPTS} intentos. Se guardará con advertencia.`);
  // Parseo de best-effort si falló, para que validateContentForWrite no rompa del todo
  const { parsedJson } = hardValidate(lastResponse, surveyContent);
  return { fullResponse: lastResponse, parsedJson, passedQA: false };
}

// ─── DESCONEXIÓN GARANTIZADA DE LA SESIÓN CDP ─────────────────────────────────
// Chrome ahora vive como proceso independiente (detached) y NUNCA se cierra
// desde acá. Pero la conexión CDP de Playwright mantiene vivo el event loop de
// Node: verificado empíricamente (Playwright 1.61) que sin browser.close() el
// proceso queda colgado para siempre, y que browser.close() sobre una conexión
// connectOverCDP SOLO desconecta el socket — Chrome sigue corriendo intacto.
let activeBrowser = null;
let isClosing = false;

async function disconnectCdp() {
  if (isClosing) return;
  isClosing = true;
  if (activeBrowser) {
    try {
      await activeBrowser.close(); // sobre CDP = desconectar, NO mata Chrome
    } catch {
      /* ya estaba desconectado */
    }
    activeBrowser = null;
  }
}

// Windows (libuv): cerrar el socket CDP y llamar process.exit() en el mismo
// tick puede crashear con "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"
// — verificado empíricamente con el código de salida 2 (cola vacía). El delay
// le da tiempo al event loop a limpiar el socket antes de forzar la salida.
// Se aplica a los 4 puntos de salida que siguen a disconnectCdp(), no solo al
// que lo disparó originalmente, porque el patrón (close + exit inmediato) es
// el mismo en los cuatro.
function exitAfterDelay(code) {
  setTimeout(() => process.exit(code), 250);
}

// Ctrl+C y señales de terminación del SO: desconectar antes de salir.
process.on('SIGINT', async () => {
  console.log('\nSeñal de interrupción recibida — desconectando de Chrome (queda abierto)...');
  await disconnectCdp();
  exitAfterDelay(0);
});
process.on('SIGTERM', async () => {
  await disconnectCdp();
  exitAfterDelay(0);
});
// Excepción no atrapada: desconectar antes de morir
process.on('uncaughtException', async (err) => {
  console.error('Excepción no controlada:', err);
  await disconnectCdp();
  exitAfterDelay(1);
});
// ──────────────────────────────────────────────────────────────────────────────

(async () => {
  let isRedo = false;
  let redoTitle = null;
  let redoLyrics = null;
  let redoFeedback = null;
  let songId = 'OFFLINE_MOCK_ID';

  try {
    if (!isDryRun) {
      if (!(await isPortUp(9333))) {
        console.log('Lanzando Chrome en puerto de debug 9333...');
        const chromeBin = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
        spawn(
          chromeBin,
          [
            `--user-data-dir=${USER_DATA_DIR}`,
            `--profile-directory=${PROFILE_DIRECTORY}`,
            `--remote-debugging-port=9333`,
            ...CHROME_ARGS,
            TARGET_URL
          ],
          { detached: true, stdio: 'ignore' }
        ).unref();

        for (let i = 0; i < 20 && !(await isPortUp(9333)); i++) {
          await new Promise((r) => setTimeout(r, 500));
        }
        if (!(await isPortUp(9333))) {
          throw new Error('Chrome no levantó el puerto de debug a tiempo.');
        }
      } else {
        console.log('Chrome ya está abierto en el puerto de debug 9333. Conectando...');
      }

      const browser = await chromium.connectOverCDP('http://localhost:9333');
      activeBrowser = browser;
      const contexts = browser.contexts();
      if (contexts.length === 0) {
        throw new Error("No hay contextos de navegador disponibles");
      }
      const context = contexts[0];
      const pages = context.pages();
      let page = pages.find((p) => p.url().includes('cancioneterna.com')) || (pages.length > 0 ? pages[0] : null);
      if (!page) {
        page = await context.newPage();
      }
      await page.bringToFront();
      if (!page.url().includes('cancioneterna.com/artists/flow')) {
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
      }

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

      redoFeedback = await readRedoFeedback(page);
      isRedo = redoFeedback !== null;

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
      songId = await readSongId(page);
      if (!songId) {
        throw new Error('No se encontró el Song ID en la página.');
      }
      console.log(`Song ID: ${songId}`);
    } else {
      console.log('--- MOCK GENERATION DRY RUN ---');
    }

    console.log('Leyendo survey.txt...');
    const surveyContent = fs.readFileSync(SURVEY_PATH, 'utf-8');

    // --- Pre-validación rápida de la encuesta ---
    const recipientMatch = surveyContent.match(/(?:What's their name|recipient(?:'s)? name)\?:\s*(.+)/i);
    if (!recipientMatch || !recipientMatch[1].trim() || recipientMatch[1].trim() === 'N/A') {
      console.warn('\n⚠️ ADVERTENCIA: La encuesta no tiene el nombre del destinatario ("What\'s their name?:").');
      console.warn('   Las reglas del prompt exigen un nombre. Esto provocará alucinaciones.');
    }
    // --------------------------------------------

    const baseUserMessage = isRedo
      ? buildRedoUserMessage(surveyContent, redoTitle, redoLyrics, redoFeedback)
      : undefined;

    const surveyHash = getSurveyHash(surveyContent);
    const cachedResponse = !isDryRun ? readCache(surveyHash) : null;

    let fullResponse, parsedJson, passedQA;

    if (cachedResponse && !isRedo) {
      console.log('♻️  Usando letra en caché local (se omitió la llamada al LLM)...');
      fullResponse = cachedResponse.fullResponse;
      parsedJson = cachedResponse.parsedJson;
      passedQA = cachedResponse.passedQA;
    } else {
      const result = await generateSongWithSelfCorrection(surveyContent, baseUserMessage);
      fullResponse = result.fullResponse;
      parsedJson = result.parsedJson;
      passedQA = result.passedQA;
      if (passedQA && !isDryRun) {
        writeCache(surveyHash, result);
      }
    }
    // Validación obligatoria antes de escribir: si la respuesta no tiene título ni
    // secciones, es truncación o chain-of-thought crudo — no guardar como song.txt
    // válido ni seguir hacia suno-fill.
    const writeCheck = validateContentForWrite(parsedJson);
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

    const now = new Date();
    const dateStr = `${now.getMonth() + 1}.${String(now.getDate()).padStart(2, '0')}.${now.getFullYear()}`;
    const notesLine = `NOTES: ${dateStr}. Hector. PS0180. Letra + Suno. Song ID: ${songId}`;

    const warningBanner = passedQA
      ? ''
      : `⚠️ ADVERTENCIA: no pasó la validación después de ${MAX_GENERATION_ATTEMPTS} intentos. Revisar manualmente.\n\n`;

    const songContent = `${warningBanner}${convertJsonToMarkdown(parsedJson)}\n\n${notesLine}`;

    fs.writeFileSync(SONG_PATH, songContent, 'utf-8');
    console.log(`\nCanción guardada en ${SONG_PATH}`);

    // Registrar el estado del pipeline para que los scripts siguientes
    // (suno-fill, flow-submit, --done) sepan sobre qué canción están trabajando
    // y puedan detectar si se cruzó con otra (ver lib/pipeline-state.js).
    // En --dry-run NO tocar state.json: el mock pisaría el estado de una
    // canción real en curso (mismo criterio que la caché en --dry-run).
    if (!isDryRun) {
      try {
        const tituloForState = extractField(fullResponse, 'Título');
        pipelineState.startNew({ songId, titulo: tituloForState, isRedo });
      } catch (e) {
        console.log('(No se pudo escribir state.json, no es crítico:', e.message, ')');
      }
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
    await disconnectCdp();
    // Higiene de disco: limpiar caché solo si el perfil creció demasiado Y
    // Chrome NO está corriendo (con Chrome vivo los archivos están en uso —
    // ahora el navegador queda abierto a propósito, así que casi siempre se
    // salta; la limpieza ocurre en las corridas donde Chrome no quedó abierto).
    try {
      // El chequeo del puerto vale también en --dry-run: el dry run no abre
      // Chrome, pero puede haber uno abierto de una sesión real — borrarle la
      // caché del perfil con el navegador vivo rompe archivos en uso.
      if (await isPortUp(9333)) {
        console.log('\n(Chrome sigue abierto — se omite la limpieza de caché del perfil.)');
      } else {
        cleanProfileCacheIfNeeded();
      }
    } catch (e) {
      console.log('No se pudo limpiar la caché (no es crítico):', e.message);
    }
  }
})().catch((err) => {
  console.error('Automation failed:', err);
  disconnectCdp().finally(() => exitAfterDelay(err.noSong ? 2 : 1));
});
