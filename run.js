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
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { clickByText, isPortUp, pauseForHumanInteraction } = require('./lib/playwright-helpers');
const { enterFlowAndEnsureAssignment } = require('./lib/flow-helpers');
const { generate, MOCK_SURVEY } = require('./lib/llm-provider');
const { notify } = require('./lib/ntfy');
const pipelineState = require('./lib/pipeline-state');
const { getSurveyHash, readCache, writeCache } = require('./lib/cache-helpers');
const { hardValidate, validateContentForWrite, extractField, convertJsonToMarkdown, isSafeToPatch, applyDeterministicLineFixes } = require('./lib/song-validate');
const { patchSongLines } = require('./lib/song-corrector');
const { extractFirstNames, extractLyricNameVariants, extractSurveyProperNouns } = require('./lib/text-helpers');
const { checkGrammarAndSpelling } = require('./lib/languagetool-check');
const { validarGuardia, formatGuardiaProblem, DEFAULT_MODEL: GUARDIA_DEFAULT_MODEL } = require('./lib/ollama-guardia');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
// --force-regen: ignora la caché local de letras (.cache/<hash>.json) y fuerza
// una llamada real al LLM. Necesario para un redo manual intencional cuando el
// CONTENIDO de una letra ya cacheada resultó estar mal (ej. un hecho inventado
// que ni hardValidate ni el Guardia atajaron a tiempo): sin esto, borrar
// state.json a mano para forzar un redo desde cero no alcanza — la caché sigue
// devolviendo la MISMA letra mala porque está indexada solo por hash de la
// encuesta, que no cambió (bug real 2026-07-14, "El Hombre de Mi Vida": la
// caché sirvió la letra con la historia mal contada incluso después de borrar
// state.json).
const forceRegen = args.includes('--force-regen');
const providerArg = args.find(a => a.startsWith('--provider='));
const provider = providerArg ? providerArg.split('=')[1] : 'claude';

const USER_DATA_DIR = path.join(os.homedir(), process.platform === 'win32' ? 'AppData\\Local\\ChromeAutomationProfile' : 'Library/Application Support/ChromeAutomationProfile');
const CHROME_PATH_GLOBAL = process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
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

You are a storyteller, not a survey transcriber. You use the details from the survey, but you give them life: show through scene and action, don't just report facts. NEVER copy-paste literal phrases from the survey. Transform the facts into poetic, singable imagery. If they say "we drank a Pacifico beer in a photo", write "a toast in a photo crossed the distance".

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
- The chorus MUST contain a "Hook" — a strong, emotional, catchy central phrase. It should not just be narrative continuation; it must feel like the emotional climax
- Prioritize words ending in open vowels (A, E, O) at the end of lines. This helps the AI singer hold long notes and sound more natural
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
- Create a clear shift in emotional tone and perspective to force a musical change (e.g. from past narrative to present revelation)
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

Suno is singing in Latin American Spanish, so it will mispronounce names that have English or complex/Anglicized spellings. You MUST modify how ONLY THOSE names are SPELLED in the lyrics using literal Spanish phonetics so Suno sings them correctly.
- **🚨 HARD RULE — never respell a name that is already standard, unambiguous Spanish.** Any name a Spanish speaker reads and pronounces correctly exactly as written — including ones with "J" (Jesús, José, Juan, Jorge, Javier, Jeremías, Josué, Julio...) — gets ZERO changes. Suno reads standard Spanish orthography correctly; "J" in real Spanish words is NOT the English "J" sound, so there is nothing to fix. Respelling "Jesús" → "Yeous" or "Jeremías" → "Yeremías" is a REAL production error that has happened more than once — the name was already correct, the "fix" broke it. Before touching any name, ask: is this name already a real, standard Spanish word/name? If yes, STOP — do not apply anything below.
- The rules below apply ONLY to names that are Anglicized, invented, or spelled in a way that does not exist in standard Spanish — e.g. "Johelyn", "Dayana", "Brayan", "Geovanny", "Jhoselyn", "Shirley", "Maryuri". These are NOT real Spanish spellings, which is why Suno mispronounces them; a name like "Jesús" or "Jeremías" IS a real Spanish spelling, so it is never a target for this section.
- Examples: "Johelyn" → "Yoelin" | "Dayana" → "Daiana" | "Brayan" → "Braian" | "Geovanny" → "Yeovani" | "Jhoselyn" → "Yoselin" | "Shirley" → "Chirley" | "Maryuri" → "Máriuri" (or "Mariúri").
- If a name has a "J" or "Y" that sounds like a vowel or an English sound BECAUSE the name itself is not standard Spanish (per the rule above), respell it literally for a Spanish reader (e.g., replace J with Y or I).
- **Accents (Tildes)**: Use explicit acute accents (tildes) to force Suno to place the stress on the correct syllable if it's naturally ambiguous (e.g., "Máriuri" instead of "Mariuri" to avoid "Mariúri").
- **Never double the 'R'** to make a soft 'r' sound. In Spanish, "rr" is a strong trill (like "perro"). If you want a soft R between vowels, use a single 'r' (e.g., "Mariuri", NEVER "Mariurri").
- If a name STARTS WITH A VOWEL (especially "A"), Suno tends to add a phantom "H"/"J" sound at the start (e.g. "Al" sung like "Jal"/"Hal"). Double the initial vowel to prevent it: "Al" → "Aal" | "Ana" → "Aana" | "Alma" → "Aalma" | "Andrea" → "Aandrea". Apply this before any other respelling rule when the name begins with a vowel.
- Never use English phonetic rules (like "Dez-ray" or "Pee-air") because Suno is reading in Spanish. Write exactly how you want it pronounced in Spanish syllables.
- Never spell a name out acrostic-style ("MARIA - M de mi amor, A de...") — it sounds forced and breaks the emotion.
- **If a "🚨 REGLA ESTRICTA DE PRONUNCIACIÓN" appears later in this message** with an exact spelling for a specific name, that spelling is already calibrated by ear against real Suno output — use it exactly as given instead of applying the general rules above to that particular name.
- Always flag any respelling you used in the **Advertencias** field of the response so it can be reviewed before sending to Suno.

### GENERAL RULES

1. **Show, don't tell.** "Your patience, your dedication, your love" = automatic regeneration. Every quality must be shown through a scene or action, not explained.

2. **Nothing invented (with one exception).** Do not invent facts, major life events, or specific memories not in the survey. This explicitly includes: **place names** (cities, countries, neighborhoods — if the survey never names a specific place, never invent one, not even a plausible-sounding one) and **specific dates or milestones tied to an event the survey did not tie them to**. It also includes **merging separate life chapters into one continuous story**: if the survey describes a first encounter that led nowhere (e.g. "never imagined a relationship because of X"), followed much later by a separate, distinct event (a reunion after other relationships, marriages, moves, or years apart), do NOT compress that gap into an unbroken romance — the gap and the separate chapters ARE the real story, and erasing them to make the story flow better is exactly as much an invention as adding a fake object or place. Before writing, mentally list every place, date, and distinct life-chapter the survey actually states, in the order it states them, and treat that list as a hard ceiling — nothing outside it may appear in the lyrics. If the survey's own wording is garbled or ambiguous, prefer the reading that preserves every distinct event it mentions over a smoother reading that quietly erases one. However, if the survey is extremely generic (e.g., "I love her way of being"), you MUST infer small, universally relatable micro-actions (e.g., a subtle smile, looking out the window, the way she walks) to ground the emotion in a cinematic scene — this exception covers generic *adjectives* only, never concrete facts like places, dates, or event sequences.

3. **Consistent address form (Spanish).** Use tú, usted, or vos based on the survey — never mix. This includes imperative phrases (e.g. "no tardes" = tú / "no tarde" = usted / "no tardés" = vos). Verify every single line including the Outro. ⚠️ ABSOLUTE: if the survey says tú, the word "vos" and voseo verb forms (sos, tenés, podés, querés, hacés, decís...) must NEVER appear — not even to complete a rhyme with "voz", "dos" or "sol". The rhyme rules NEVER override this rule: if a rhyme needs "vos", rewrite the whole line instead. (Real failure: "quise saber más de vos" in a tú song — unacceptable, the client notices immediately.)

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

16. **Strong Rhyme Scheme.** You MUST use a clear, strong rhyme scheme at the end of lines (e.g., AABB or ABAB). Weak or non-existent rhymes confuse the musical AI, resulting in spoken-word delivery. Do not force filler words just to rhyme, but a structural rhyme is mandatory.

17. **Metrical Consistency & Short Lines.** Keep lines short (ideally 8-12 syllables) and consistent within a section. Long, prose-like lines force the AI singer to speed up or recite the lyrics instead of singing them.

18. **Banned Clichés List.** Spanish romantic/Christian music suffers from predictable writing. YOU MUST AVOID:
    - Rhyming "corazón" with "razón", "amor" with "dolor" or "color", "vida" with "herida"
    - Phrases like: "Ángel caído del cielo", "Luz en la oscuridad", "Desde el primer día que te vi", "Dios me dio a ti", "Eres mi todo"
    - Even if the user uses a cliché in the survey, elevate it to a fresh, specific poetic image (e.g. if they say "you are my light", write "you kept the porch lamp on when I was lost"). Find a fresh way to say it every time.

19. **Conversational Flow.** Use natural, warm, conversational language. Avoid overly complex, academic, or rigid words (e.g. "existencia", "diferencias") that sound robotic when sung.

### PROFESSIONAL SONGWRITING CRAFT (ADVANCED)

These go beyond structural correctness — they separate a professional song from a generic one. Apply all of them.

20. **One Central Image (the "conceit").** Pick ONE concrete image or object from the survey (a place, an object, a recurring gesture) and build the ENTIRE song around it — introduce it in Verse 1, develop it in Verse 2, let the Chorus elevate it emotionally, and resolve it in the Outro. Do not scatter 4-5 unrelated images across the song; a professional song feels like it's about one thing seen from different angles, not a list of nice moments.

21. **Circular Ending (callback to Verse 1).** The Outro must callback to the SPECIFIC concrete image or moment from Verse 1 — not just restate the Chorus's sentiment in different words. This is what makes a song feel complete instead of just stopping. Example: if Verse 1 opens on "la cocina a las seis de la mañana", the Outro should return to that kitchen, that hour, changed by everything the song just said.

22. **Specific (Verse) vs. Universal (Chorus) contrast.** Verses live in concrete, personal, small detail (an object, a specific moment, a sensory detail) — that's what makes THIS survey's song different from every other song. Choruses lift to universal, repeatable, anthemic language that anyone could feel — that's what makes it singable and emotionally big. If a verse sounds as generic as the chorus, it has failed; if a chorus is as specific as a verse, it won't be memorable.

23. **Concrete nouns over abstract nouns.** Whenever the survey gives you ANY concrete detail (an object, a place, an activity, a physical gesture), use it instead of abstract nouns like "amor", "vida", "tiempo", "recuerdos". Abstract nouns are only acceptable in the Chorus, where they serve the universal-lift purpose of rule 22 — never as a substitute for a concrete detail you could have used in a Verse.

24. **Natural word order — never invert syntax to force a rhyme.** Spanish has flexible word order, but forcing it for rhyme sounds like a bad translation ("tu amor a mí me dio" instead of "me diste tu amor"). If a rhyme requires unnatural syntax, find a different rhyme or restructure the line — natural spoken order always wins over a forced rhyme.

25. **The Bridge must contain a real pivot, not just another detail.** The Bridge is the one place in the song allowed to shift: either a tense shift (present/past → future, e.g. "cuando ya no esté", "algún día que falte") or a perspective shift (zooming out from the personal detail to the larger truth the whole song has been building toward). A Bridge that's just one more vulnerable anecdote in the same tense/perspective as the Verses is a missed opportunity, not a real Bridge.

26. **The "quotable line" test.** The key line of Chorus 1 (usually the hook, right after the name) should be strong enough to stand alone out of context — something a listener would want as a photo caption or a screenshot to send someone. If the line only makes sense embedded in the song, it's not doing its job as the hook.

27. **One metaphor per line.** Never stack two or more different images in the same line (e.g. "la luz que enciende mi camino de cristal" mixes a light metaphor and a glass/path metaphor). One image, fully developed, per line — layering metaphors reads as amateur and confuses the musical AI's phrasing.

28. **Verb tense as a narrative arc across sections.** Use tense deliberately, not just consistently: Verses in past tense (the memory), Chorus in present tense (the current devotion), Bridge shifting to future (the promise, "cuando ya no esté", "algún día que falte"). This creates a real narrative arc instead of the whole song sitting flat in one tense.

29. **A sensory anchor in every Verse.** Each Verse must include at least one concrete sensory detail (a smell, a sound, a texture, a specific color) tied to a real fact from the survey — not just generic visual description. This is what makes the scene feel lived-in instead of stated.

30. **Chorus 1 / Chorus 2 parallelism, not repetition.** Chorus 2 should mirror Chorus 1's syllable pattern and rhyme scheme (same musical shape) while escalating emotionally or revealing something new — real variation on a theme, not the same idea with swapped words.

31. **Negative space — not every line at maximum intensity.** A professional song breathes: simpler, quieter "setup" lines before the line that hits hardest. If every single line is emotionally maximal, the song reads as overwritten (purple prose) and the real emotional peaks lose their power from lack of contrast.

32. **No explanatory connector words.** Avoid "porque", "por eso", "entonces" and similar literal connectors — a songwriter implies causation by juxtaposing images, not by explaining it like a spoken essay. If a line needs "porque" to make sense, restructure it so the connection is felt, not stated.

33. **Rich rhyme over poor rhyme (rima rica vs. rima pobre).** Avoid rhyming two words from the same grammatical category with the same inflection (e.g. two "-ando" gerunds, or two words with the same plural "-es" ending) — this is "rima pobre" in Spanish poetics and sounds lazy. Prefer rhymes across different grammatical categories (noun/verb, adjective/noun) for a richer, more sophisticated sound.

34. **"Would a real person say this out loud?" filter.** Beyond general conversational flow (rule 19), run every line through a stricter final filter: would someone from the survey's actual register/region say this in real conversation, or does it only exist in flowery written poetry? Cut anything that fails this test, even if it rhymes well.

35. **Consistent metrical anchor position for the hook.** The name or key hook phrase should land in the SAME metrical position across every Chorus (not just "first word") — same syllable count leading into it — so the ear locks onto it on repeat listens instead of it landing in a slightly different spot each time.

36. **Stress lands at line-end.** Prefer words whose natural spoken stress falls on the last syllable of the line (where the melodic/rhyme weight naturally sits), especially at Chorus endings — avoids forcing Suno to sing an unnatural emphasis on an unstressed syllable to make the rhyme land.

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
    "sin_acrostico": true,
    "metrica_corta_y_consistente": true,
    "rima_fuerte_evidente": true,
    "adaptacion_poetica_sin_copypaste": true,
    "coros_con_gancho": true,
    "vocales_abiertas_en_coro": true,
    "un_solo_motivo_central": true,
    "cierre_circular_con_verse_1": true,
    "contraste_especifico_vs_universal": true,
    "sin_inversion_poetica_forzada": true,
    "bridge_con_giro_real": true,
    "linea_de_gancho_quotable": true,
    "una_metafora_por_linea": true,
    "arco_de_tiempo_verbal_por_seccion": true,
    "ancla_sensorial_en_cada_verso": true,
    "paralelismo_chorus_1_y_2": true,
    "espacio_negativo_sin_maxima_intensidad_constante": true,
    "sin_conectores_explicativos": true,
    "rima_rica_no_pobre": true,
    "gancho_en_misma_posicion_metrica": true
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

// ── Capa 2 de QA ortográfico/gramatical: LanguageTool ──────────────────────
// lib/spanish-spellcheck.js (Capa 1, corre DENTRO de hardValidate, offline)
// atrapa palabras inválidas contra un diccionario, pero no resuelve
// ambigüedad gramatical real ("esta" demostrativo vs "está" verbo — ambas
// son palabras válidas, un diccionario no puede saber cuál corresponde).
// Este gate llama a LanguageTool (lib/languagetool-check.js) DESPUÉS de que
// hardValidate ya dio valid:true, como red de seguridad adicional — pedido
// explícito de Hector tras el bug real de "Fogata en la Arena" ("que eso
// NUNCA FALLE", ver LESSONS.md). Nunca falla en silencio: si LanguageTool
// no responde, la canción NO se asume limpia — se marca para revisión
// manual en vez de mandarla igual.
const MAX_GRAMMAR_PATCH_ROUNDS = 2;

async function runGrammarGate(parsedJson, surveyContent) {
  const firstNames = extractFirstNames(surveyContent);
  const lyricsText = Object.values(parsedJson.letras || {}).flat().join('\n');
  const phoneticVariants = Object.values(extractLyricNameVariants(lyricsText, firstNames));
  let dictVariants = [];
  try {
    const dictPath = path.join(__dirname, 'lib', 'name-dictionary.json');
    if (fs.existsSync(dictPath)) {
      dictVariants = Object.values(JSON.parse(fs.readFileSync(dictPath, 'utf-8')));
    }
  } catch (e) {
    // Best-effort — si no se puede leer, el filtro de exclusión queda más
    // corto pero el gate igual corre (no bloquea la entrega por esto).
  }
  const surveyProperNouns = extractSurveyProperNouns(surveyContent);
  const excludeWords = [...firstNames, ...phoneticVariants, ...dictVariants, ...surveyProperNouns];

  let currentJson = parsedJson;
  for (let round = 0; round <= MAX_GRAMMAR_PATCH_ROUNDS; round++) {
    const result = await checkGrammarAndSpelling(currentJson.letras, { excludeWords });

    if (!result.ok) {
      console.warn(`\n⚠️ LanguageTool no disponible (${result.error}) — se entrega con advertencia de revisión manual en vez de asumir que la letra está limpia.`);
      return {
        clean: false,
        unavailable: true,
        parsedJson: currentJson,
        failures: [`LanguageTool no disponible (${result.error}) — revisar ortografía/gramática a mano antes de mandar a Suno`],
      };
    }

    if (result.issues.length === 0) {
      console.log(round === 0 ? '✅ LanguageTool: sin errores de ortografía/gramática.' : `✅ LanguageTool: limpio tras ${round} ronda(s) de corrección.`);
      return { clean: true, parsedJson: currentJson, fullResponse: JSON.stringify(currentJson) };
    }

    console.log(`\n📝 LanguageTool encontró ${result.issues.length} error(es) de ortografía/gramática:`);
    result.issues.forEach((i) => console.log(`  • [${i.section}] línea ${i.lineIndex + 1}: ${i.detail}`));

    if (round === MAX_GRAMMAR_PATCH_ROUNDS) {
      return {
        clean: false,
        parsedJson: currentJson,
        failures: result.issues.map((i) => `LanguageTool: [${i.section}] línea ${i.lineIndex + 1}: ${i.detail}`),
      };
    }

    try {
      const patchedJson = await patchSongLines(currentJson, result.issues);
      const revalidated = hardValidate(JSON.stringify(patchedJson), surveyContent);
      if (!revalidated.valid) {
        console.log(`⚠️ El parche de LanguageTool rompió una regla estructural (${revalidated.failures.join(' | ')}) — se detiene el gate, sigue el flujo normal.`);
        return { clean: false, parsedJson: patchedJson, failures: revalidated.failures };
      }
      currentJson = revalidated.parsedJson;
    } catch (e) {
      console.log(`⚠️ Corrector barato falló parcheando errores de LanguageTool (${e.message}) — se entrega con advertencia de revisión manual.`);
      return { clean: false, parsedJson: currentJson, failures: result.issues.map((i) => `LanguageTool: [${i.section}] línea ${i.lineIndex + 1}: ${i.detail}`) };
    }
  }
}

async function generateSongWithSelfCorrection(surveyContent, baseUserMessageOverride) {
  const baseUserMessage = baseUserMessageOverride || `Here is the survey for this song:\n\n${surveyContent}`;
  let userMessage = baseUserMessage;
  let lastResponse = null;
  let lastFailures = [];
  let maxTokens = DEFAULT_MAX_TOKENS;
  const surveyFirstNames = extractFirstNames(surveyContent);

  // Mejor candidato entre TODOS los intentos (2026-07-13): cada regen es una
  // tirada nueva que puede arreglar una cosa y romper otra — bug real ("El
  // Lago Donde Aprendí a Quedarme"): el intento 2 corrigió la tilde pero
  // rompió el conteo de líneas, el 3 re-rompió la tilde... y el pipeline
  // guardaba el ÚLTIMO intento, o sea el peor de los tres. Ahora, si se
  // agotan los intentos, se guarda el candidato con MENOS fallos (desempate:
  // el que tenga solo fallos patcheables), no el más reciente.
  let best = null; // { response, failures, isValid }
  const candidateScore = (failures, isValid) => {
    const penalty = isValid ? 0 : 100;
    return penalty + failures.length + (isSafeToPatch(failures) ? 0 : 0.5);
  };
  const considerCandidate = (response, failures, isValid) => {
    if (!best || candidateScore(failures, isValid) < candidateScore(best.failures, best.isValid)) {
      best = { response, failures, isValid };
    }
  };

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    console.log(`\nGenerando letra con ${provider} (intento ${attempt}/${MAX_GENERATION_ATTEMPTS}, max_tokens=${maxTokens})...`);
    const { text, stopReason } = await generateSongWithProvider(userMessage, provider, maxTokens);
    lastResponse = text;

    let { valid, failures, parsedJson, patchableIssues } = hardValidate(lastResponse, surveyContent);
    lastFailures = failures;

    // Corrector DETERMINÍSTICO (gratis, sin LLM, cero ambigüedad) — antes de
    // gastar Haiku o un regen completo con el modelo caro, probamos
    // reemplazos de texto directos: tildes/eñes con única sustitución
    // válida, nombres españoles estándar sin tilde ("Jesus"->"Jesús", vía
    // la ortografía canónica de la lista curada — el diccionario no cubre
    // la mayoría en minúscula), puntuación prohibida (—;: -> coma) y
    // dígitos->palabras sin problemas de género (ver
    // applyDeterministicLineFixes en lib/song-validate.js). Bug real
    // 2026-07-13 ("El Lago Donde Aprendí a Quedarme"): "maria"->"María"
    // sobrevivió 3 regeneraciones completas porque el modelo no se
    // autocorregía de forma confiable pese a instrucciones explícitas —
    // este reemplazo mecánico no depende de que ningún modelo "se acuerde"
    // de la corrección, así que la validación para esta clase de error
    // SIEMPRE termina pasando en vez de solo detectarse y quedar con
    // advertencia.
    if (!valid && parsedJson?.letras) {
      const { letras: fixedLetras, appliedCount, fixes } = applyDeterministicLineFixes(parsedJson.letras, { firstNames: surveyFirstNames });
      if (appliedCount > 0) {
        const patchedText = JSON.stringify({ ...parsedJson, letras: fixedLetras });
        const revalidated = hardValidate(patchedText, surveyContent);
        console.log(`🔧 Corrector determinístico (sin LLM): ${fixes.join(', ')}.`);
        ({ valid, failures, parsedJson, patchableIssues } = revalidated);
        lastResponse = patchedText;
        lastFailures = failures;
      }
    }
    if (!valid) considerCandidate(lastResponse, lastFailures, false);

    if (valid) {
      console.log('✅ Validación estructural + QA: todos los ítems pasaron.');

      const grammarResult = await runGrammarGate(parsedJson, surveyContent);
      if (grammarResult.clean) {
        return { fullResponse: grammarResult.fullResponse, parsedJson: grammarResult.parsedJson, passedQA: true };
      }
      if (grammarResult.unavailable) {
        // Problema de red, no de contenido — gastar los MAX_GENERATION_ATTEMPTS
        // regenerando la letra entera no lo arregla. Se entrega de una con la
        // advertencia en vez de quemar reintentos/tokens en vano.
        const fullResponse = JSON.stringify(grammarResult.parsedJson);
        return { fullResponse, parsedJson: grammarResult.parsedJson, passedQA: false, lastFailures: grammarResult.failures };
      }

      // LanguageTool sí respondió pero quedaron errores tras sus propias
      // rondas de parcheo — cae al flujo normal de abajo (logueo +
      // instrucciones correctivas para el próximo intento), igual que
      // cualquier otro fallo de hardValidate.
      lastFailures = grammarResult.failures;
      lastResponse = JSON.stringify(grammarResult.parsedJson);
      parsedJson = grammarResult.parsedJson;
      considerCandidate(lastResponse, lastFailures, true);
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
        let patchedText = JSON.stringify(patchedJson);
        let revalidated = hardValidate(patchedText, surveyContent);
        // Haiku puede introducir un typo de tilde nuevo en la línea que
        // reescribió — una pasada determinística sobre SU resultado es
        // gratis y evita descartar un parche que quedó a una tilde de estar
        // limpio.
        if (!revalidated.valid && revalidated.parsedJson?.letras) {
          const { letras: fixedLetras, appliedCount } = applyDeterministicLineFixes(revalidated.parsedJson.letras, { firstNames: surveyFirstNames });
          if (appliedCount > 0) {
            patchedText = JSON.stringify({ ...revalidated.parsedJson, letras: fixedLetras });
            revalidated = hardValidate(patchedText, surveyContent);
          }
        }
        if (revalidated.valid) {
          console.log('✅ Parche barato resolvió todos los fallos — se evitó un regen completo con el modelo caro.');
          // Mismo gate gramatical que el camino valid normal — antes el
          // parche exitoso se salteaba LanguageTool por completo, una vara
          // distinta para la misma letra (auditoría 2026-07-13).
          const patchedGrammar = await runGrammarGate(revalidated.parsedJson, surveyContent);
          if (patchedGrammar.clean) {
            return { fullResponse: patchedGrammar.fullResponse, parsedJson: patchedGrammar.parsedJson, passedQA: true };
          }
          if (patchedGrammar.unavailable) {
            const fullResponse = JSON.stringify(patchedGrammar.parsedJson);
            return { fullResponse, parsedJson: patchedGrammar.parsedJson, passedQA: false, lastFailures: patchedGrammar.failures };
          }
          lastFailures = patchedGrammar.failures;
          lastResponse = JSON.stringify(patchedGrammar.parsedJson);
          considerCandidate(lastResponse, lastFailures, true);
        } else {
          console.log(`⚠️ El parche no dejó todo limpio (${revalidated.failures.length} fallo[s] restante[s]) — sigue el flujo normal.`);
          considerCandidate(patchedText, revalidated.failures, false);
        }
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
  // Se guarda el MEJOR candidato de los 3 intentos, no el último — el regen
  // puede arreglar una cosa y romper otra, y el intento final no tiene por
  // qué ser el menos malo (bug real 2026-07-13, ver `best` arriba).
  if (best && best.response !== lastResponse) {
    console.log(`   (guardando el mejor intento visto: ${best.failures.length} fallo[s], vs ${lastFailures.length} del último)`);
    lastResponse = best.response;
    lastFailures = best.failures;
  }
  // Parseo de best-effort si falló, para que validateContentForWrite no rompa del todo
  const { parsedJson } = hardValidate(lastResponse, surveyContent);
  return { fullResponse: lastResponse, parsedJson, passedQA: false, lastFailures };
}

// ── REGLA INQUEBRANTABLE (pedido explícito de Hector 2026-07-09) ─────────────
// Categorías de fallo que JAMÁS pueden llegar a Suno/al Flow, ni siquiera con
// el banner de "revisar manualmente": si sobreviven a los 3 intentos de
// regeneración, run.js ABORTA (exit != 0, cero créditos gastados) en vez de
// continuar con la advertencia. Nació del bug real de "más de vos" con trato
// tú ("Luz Que No Buscaba"): el checklist del modelo se auto-calificó ✓ y el
// pipeline siguió de largo hasta generar el audio. El resto de los fallos
// (métrica, estructura menor) mantienen el comportamiento de siempre
// (advertencia + revisión manual) — abortar por TODO convertiría cualquier
// falso positivo del validador en una cola trabada.
const FATAL_FAILURE_PATTERNS = [
  /^Mezcla de trato/,
];

function findFatalFailures(failures) {
  return (failures || []).filter((f) => FATAL_FAILURE_PATTERNS.some((rx) => rx.test(f)));
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

  // Segunda capa de la misma protección (2026-07-13, ver LESSONS.md — bug
  // real de Create duplicado): si hay un --loop real corriendo (watchdog
  // vivo), un --dry-run manual en paralelo corre una carrera real contra
  // el backup/restore de song.txt — si el watchdog relanza el --loop justo
  // en la ventana en que song.txt tiene el mock puesto, el resume falla y
  // el ciclo siguiente puede terminar regenerando/reprocesando una canción
  // real (visto en vivo). Más vale rechazar el dry-run de entrada que
  // arriesgar esa carrera — correr el dry-run real DESPUÉS de que el
  // --loop cierre, o pausarlo con Ctrl+C primero.
  if (isDryRun) {
    const { isWatchdogRunning } = require('./watchdog');
    if (isWatchdogRunning()) {
      console.error('\n❌ Hay un --loop real corriendo (watchdog activo) — --dry-run rechazado para no arriesgar una carrera con song.txt de una canción real en curso.');
      console.error('   Esperá a que termine el --loop, o pausalo con Ctrl+C, antes de correr un --dry-run.\n');
      exitAfterDelay(1);
      return;
    }
  }

  // song.txt se respalda antes y se restaura SIEMPRE al final en --dry-run —
  // el mock jamás debe pisar la letra de una canción real en curso (mismo
  // criterio que state.json/caché en --dry-run, ver más abajo). Vive ACÁ,
  // no solo en el wrapper de start-flow.js --dry-run, porque `node run.js
  // --dry-run` corrido directo (sin pasar por start-flow.js) no tenía NINGUNA
  // protección — bug real: pisó song.txt de una canción real en curso a
  // mitad de una corrida de --loop (2026-07-13, ver LESSONS.md).
  const DRY_RUN_BACKUP_PATH = SONG_PATH + '.dry-run-backup';
  let dryRunBackedUp = false;
  if (isDryRun && fs.existsSync(SONG_PATH)) {
    fs.copyFileSync(SONG_PATH, DRY_RUN_BACKUP_PATH);
    dryRunBackedUp = true;
    console.log('🛟 song.txt actual respaldado (se restaura al final del ensayo).\n');
  }

  try {
    if (!isDryRun) {
      if (!(await isPortUp(9333))) {
        console.log('Lanzando Chrome en puerto de debug 9333...');
        const chromeBin = CHROME_PATH_GLOBAL;
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

      const browser = await chromium.connectOverCDP('http://localhost:9333', { noDefaults: true });
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

      // Salvaguarda anti-duplicado (bug real 2026-07-13, "Un Ángel en
      // Jenner"): si el proceso de --loop murió DESPUÉS de llenar Suno (o
      // más adelante) y se relanzó, `--resume` solo se respeta en el
      // PRIMER ciclo — si ese primer intento de --resume falla por
      // cualquier motivo (song.txt no coincide, lo que sea), los ciclos
      // siguientes arrancan de cero. Como la asignación en el Flow sigue
      // activa (nadie hizo Submit todavía), `enterFlowAndEnsureAssignment`
      // la encuentra de nuevo y este punto del código estaba a punto de
      // regenerar la letra y mandar todo el pipeline OTRA VEZ a Suno —
      // Create duplicado, créditos gastados dos veces, visto en vivo. Acá
      // es la única fuente confiable de "hasta dónde llegamos ya" —si dice
      // que este Song ID ya pasó de "generated" (Suno ya se llenó), NO hay
      // que tocar Suno de nuevo bajo ninguna circunstancia: abortar fuerte
      // y avisar urgente en vez de reprocesar en silencio. `--dry-run`
      // nunca dispara esto (nunca toca Suno de verdad).
      const existingState = pipelineState.read();
      const ALREADY_PAST_GENERATION = new Set([
        pipelineState.STAGES.SUNO_FILLED,
        pipelineState.STAGES.FLOW_FILLED,
        pipelineState.STAGES.COMPLETED,
      ]);
      if (!isDryRun && existingState?.songId === songId && ALREADY_PAST_GENERATION.has(existingState.stage)) {
        const msg = `"${existingState.titulo}" (Song ID ${songId}) ya pasó por Suno en esta sesión (etapa "${existingState.stage}") — NO se regenera para evitar un Create duplicado. Revisá manualmente en Suno/Flow si esta canción ya está lista (probablemente sí). Si de verdad hace falta rehacerla desde cero, borrá state.json a mano primero.`;
        await notify(`🚨 ${msg}`, { title: '🛑 Duplicado evitado', priority: 'urgent', tags: 'rotating_light' }).catch(() => {});
        throw new Error(msg);
      }
    } else {
      console.log('--- MOCK GENERATION DRY RUN ---');
    }

    // En --dry-run se usa la encuesta MOCK consistente con MOCK_RESPONSE
    // (lib/llm-provider.js) en vez de la survey.txt real del disco: la
    // respuesta mock es fija, así que validarla contra los nombres de una
    // encuesta real cualquiera hacía que hardValidate fallara SIEMPRE y todo
    // dry-run terminara "con advertencia" — ruido que tapa advertencias
    // reales (auditoría 2026-07-09). survey.txt real no se toca.
    console.log(isDryRun ? 'Usando encuesta MOCK (dry-run)...' : 'Leyendo survey.txt...');
    const surveyContent = isDryRun ? MOCK_SURVEY : fs.readFileSync(SURVEY_PATH, 'utf-8');

    // --- Pre-validación rápida de la encuesta ---
    // Reusa extractFirstNames (lib/text-helpers.js) en vez de un regex propio:
    // ese ya tolera apóstrofes rectos y curvos ("What's"/"What's") y filtra
    // palabras de relleno — un regex separado acá había divergido y no
    // reconocía el apóstrofe curvo, generando falsos positivos de "sin nombre".
    if (extractFirstNames(surveyContent).length === 0) {
      console.warn('\n⚠️ ADVERTENCIA: La encuesta no tiene el nombre del destinatario ("What\'s their name?:").');
      console.warn('   Las reglas del prompt exigen un nombre. Esto provocará alucinaciones.');
    }
    // --------------------------------------------

    // --- Inyección del Diccionario de Nombres ---
    let dictInjection = '';
    const extractedNames = extractFirstNames(surveyContent);
    let namesNotInDict = extractedNames;
    if (extractedNames.length > 0) {
      try {
        const dictPath = path.join(__dirname, 'lib', 'name-dictionary.json');
        if (fs.existsSync(dictPath)) {
          const dict = JSON.parse(fs.readFileSync(dictPath, 'utf-8'));
          const matches = [];
          namesNotInDict = extractedNames.filter((name) => !dict[name.toLowerCase()]);
          for (const name of extractedNames) {
            const lowerName = name.toLowerCase();
            if (dict[lowerName]) {
              matches.push(`"${name}" -> "${dict[lowerName]}"`);
            }
          }
          if (matches.length > 0) {
            dictInjection = `\n\n🚨 REGLA ESTRICTA DE PRONUNCIACIÓN: Para que el audio se genere correctamente, DEBES escribir los siguientes nombres EXACTAMENTE con esta fonética/ortografía en todas las secciones de la letra:\n- ${matches.join('\n- ')}\n`;
            console.log(`\n📚 Diccionario fonético activado para: ${matches.join(', ')}`);
          }
        }
      } catch (e) {
        console.warn('\n⚠️ No se pudo leer name-dictionary.json:', e.message);
      }
    }
    // --------------------------------------------

    const defaultUserMessage = `Here is the survey for this song:\n\n${surveyContent}`;
    let finalBaseUserMessage = isRedo
      ? buildRedoUserMessage(surveyContent, redoTitle, redoLyrics, redoFeedback)
      : defaultUserMessage;
      
    if (dictInjection) {
      finalBaseUserMessage += dictInjection;
    }

    const surveyHash = getSurveyHash(surveyContent);
    if (forceRegen) console.log('🔁 --force-regen: ignorando la caché local, se llama al LLM de nuevo aunque haya una letra cacheada.');
    const cachedResponse = !isDryRun && !forceRegen ? readCache(surveyHash) : null;

    let fullResponse, parsedJson, passedQA;
    let qaFailures = []; // fallos del QA duro que quedaron sin resolver — contexto para la pasada informada del Guardia

    // La caché guarda letras que pasaron el QA de SU momento — si el
    // validador se endureció después (ej. la regla inquebrantable de trato,
    // 2026-07-09), una letra cacheada puede violar las reglas ACTUALES.
    // Re-validar antes de usarla: si viola una regla fatal, se descarta y se
    // regenera (caso real: la letra con "más de vos" quedó cacheada porque
    // el validador viejo no miraba el trato tú).
    let usableCache = null;
    if (cachedResponse && !isRedo) {
      const recheck = hardValidate(cachedResponse.fullResponse, surveyContent);
      const fatalInCache = findFatalFailures(recheck.failures);
      if (fatalInCache.length > 0) {
        console.log('♻️→🗑️  La letra en caché viola una regla inquebrantable ACTUAL — se descarta y se regenera:');
        fatalInCache.forEach((f) => console.log(`  • ${f}`));
      } else {
        usableCache = cachedResponse;
      }
    }

    if (usableCache) {
      console.log('♻️  Usando letra en caché local (se omitió la llamada al LLM)...');
      fullResponse = usableCache.fullResponse;
      parsedJson = usableCache.parsedJson;
      passedQA = usableCache.passedQA;
    } else {
      const result = await generateSongWithSelfCorrection(surveyContent, finalBaseUserMessage);
      fullResponse = result.fullResponse;
      parsedJson = result.parsedJson;
      passedQA = result.passedQA;
      qaFailures = result.lastFailures || [];
      if (passedQA && !isDryRun) {
        writeCache(surveyHash, result);
      }

      // REGLA INQUEBRANTABLE: los fallos fatales (mezcla de trato) NUNCA
      // siguen de largo con el banner de advertencia — abortan acá, antes de
      // song.txt, antes de Suno, antes de gastar un solo crédito. Ver
      // FATAL_FAILURE_PATTERNS arriba y LESSONS.md 2026-07-09 ("más de vos").
      if (!passedQA) {
        const fatal = findFatalFailures(result.lastFailures);
        if (fatal.length > 0) {
          console.error('\n🛑 REGLA INQUEBRANTABLE VIOLADA — el pipeline se detiene SIN gastar créditos:');
          fatal.forEach((f) => console.error(`  • ${f}`));
          await notify(
            `La letra violó una regla inquebrantable tras ${MAX_GENERATION_ATTEMPTS} intentos y el pipeline se detuvo ANTES de Suno (cero créditos gastados):\n${fatal.join('\n')}\n\nCorré de nuevo: node start-flow.js`,
            { title: '🛑 Letra rechazada — regla inquebrantable', priority: 'urgent', tags: 'no_entry' }
          ).catch(() => {});
          throw new Error(`Regla inquebrantable violada tras ${MAX_GENERATION_ATTEMPTS} intentos: ${fatal.join('; ')}`);
        }
      }
    }
    // Validación obligatoria antes de escribir: si la respuesta no tiene título ni
    // secciones, es truncación o chain-of-thought crudo — no guardar como song.txt
    // válido ni seguir hacia suno-fill.
    // Log de curación del diccionario fonético: cuando el LLM respelleó por su
    // cuenta (foneticaAplicada=true) un nombre que NO estaba en
    // lib/name-dictionary.json, dejarlo anotado acá para revisar de oído y
    // agregarlo a mano más adelante — en vez de depender de que alguien se
    // acuerde de mirar las Advertencias de cada song.txt. Best-effort, nunca
    // bloquea el pipeline. Se salta en --dry-run (mock, no es un caso real).
    if (!isDryRun && parsedJson?.foneticaAplicada === true && namesNotInDict.length > 0) {
      try {
        const logsDir = path.join(__dirname, 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        fs.appendFileSync(
          path.join(logsDir, 'phonetic-candidates.jsonl'),
          JSON.stringify({
            ts: new Date().toISOString(),
            songId,
            candidateNames: namesNotInDict,
            advertencias: parsedJson.advertencias || null,
          }) + '\n',
          'utf-8'
        );
      } catch {
        // best-effort
      }
    }

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

    // En --dry-run, song.txt se restaura a la letra real en el finally de
    // esta misma función apenas termina — start-flow.js ya no puede leer el
    // mock del disco después de este punto. El chequeo de que el mock es
    // parseable por los mismos scripts que leen song.txt en un pipeline real
    // (parseSongFile, único parser canónico — ver lib/song-file.js) tiene que
    // vivir ACÁ, con el mock todavía en memoria/disco.
    if (isDryRun) {
      const { parseSongFile } = require('./lib/song-file');
      const parsed = parseSongFile(songContent);
      const mockOk = !!(parsed.titulo && parsed.lyrics && parsed.estilo);
      if (!mockOk) {
        throw new Error('El song.txt mock no pasa parseSongFile (título/letra/estilo Suno).');
      }
      console.log('✅ song.txt mock parseable por parseSongFile (suno-fill.js/flow-submit.js).');
    }

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

    // ── "El Guardia" — Capa 3 de QA de letra (Ollama local, informativo) ────
    // Segunda opinión INDEPENDIENTE sobre cómo está armada la canción
    // (coherencia/rima/tono/fidelidad/gancho) — hoy ese juicio subjetivo solo
    // lo hace el propio modelo generador vía su qaChecklist autoevaluado.
    // NUNCA bloquea ni gasta reintentos (mismo criterio que CLAP/NISQA:
    // informativo hasta calibrar en vivo — ver LESSONS.md). Corre SIEMPRE
    // que haya letra, pase o no pase hardValidate (pedido explícito de
    // Hector 2026-07-13: "OLLAMA SIEMPRE CORRA no a veces SIEMPRE" — antes
    // se saltaba entero si passedQA era false, así que una letra con
    // ⚠️ ADVERTENCIA tras agotar los 3 intentos se quedaba SIN la segunda
    // opinión justo cuando más falta hacía. Ollama es local y gratis, así
    // que no hay costo real en correrlo también sobre letras con warning.
    if (parsedJson?.letras) {
      // Una consulta al Guardia con UN reintento ante fallo (Ollama es local
      // y gratis — "sin límite de reintentos" tiene que ser verdad en la
      // práctica, no solo en el diseño). Si el modelo primario es el 14b, el
      // reintento baja al 8b (entra entero en VRAM, responde en segundos):
      // el fallo típico es timeout de carga fría del 14b con offload parcial.
      const guardiaPrimario = process.env.GUARDIA_MODEL || GUARDIA_DEFAULT_MODEL;
      const guardiaFallback = guardiaPrimario === 'qwen3:8b' ? null : 'qwen3:8b';
      const consultarGuardia = async (etiqueta, { qaContext = null, keepAlive = 0 } = {}) => {
        const payload = { letras: parsedJson.letras, titulo: parsedJson.titulo, survey: surveyContent, qaContext, estiloSuno: parsedJson.estiloSuno };
        let r = await validarGuardia(payload, { keepAlive });
        if (!r.ok && guardiaFallback) {
          console.log(`🛡️  ${etiqueta} falló (${r.error}) — reintentando con ${guardiaFallback}...`);
          r = await validarGuardia(payload, { keepAlive, model: guardiaFallback });
        }
        return r;
      };
      const logPass = (etiqueta, g) => {
        if (g.ok) {
          console.log(`🛡️  ${etiqueta} (Ollama/${g.model}, ${Math.round(g.durationMs / 1000)}s): ${g.veredicto}`);
          console.log(`   coherencia=${g.coherencia} rima=${g.rima} tono=${g.tono} fidelidad=${g.fidelidad} gancho=${g.gancho} confianza=${g.confianza ?? '-'} estiloCoincide=${g.estiloCoincide ?? '-'} aprobada=${g.aprobada}`);
          g.problemas.forEach((p) => console.log(`   • ${formatGuardiaProblem(p)}`));
        } else {
          console.log(`🛡️  ${etiqueta} no disponible (${g.error}) — sin señal de esta pasada.`);
        }
      };

      // Pasada 1: CIEGA (sin el resultado del QA duro) — juicio independiente.
      // keepAlive '5m' salvo que sea la única pasada (--dry-run): las pasadas
      // siguientes son inmediatas y recargar el 14b desde frío en cada una
      // duplicaba la latencia total al pedo; los 5 min expiran solos mucho
      // antes de que el pipeline de audio necesite la VRAM.
      console.log('\n🛡️  Consultando al Guardia (Ollama local, puede tardar unos minutos la primera vez)...');
      const guardiaResult = await consultarGuardia('Pasada 1', { keepAlive: isDryRun ? 0 : '5m' });
      logPass('El Guardia — pasada 1 (ciega)', guardiaResult);
      let guardiaSegunda = null;
      let guardiaDesempate = null;
      let extraccionHechos = null;
      let hechosSinRespaldo = null;

      if (guardiaResult.ok && !isDryRun) {
        // Pasada 2: INFORMADA — recibe los fallos que el QA duro dejó sin
        // resolver y debe confirmarlos o descartarlos. Antes las 2 pasadas
        // eran idénticas (mismo prompt, mismo modelo): solo medían ruido de
        // sampleo. Ciega + informada extrae más señal con el mismo costo, y
        // genera el dato de calibración "¿el Guardia ve lo mismo que el
        // validador?" (2026-07-13). --dry-run se queda con una sola pasada.
        console.log('\n🛡️  Segunda pasada del Guardia (informada con el resultado del QA duro)...');
        guardiaSegunda = await consultarGuardia('Pasada 2', {
          qaContext: { passedQA, failures: qaFailures },
          keepAlive: '5m',
        });
        logPass('El Guardia — pasada 2 (informada)', guardiaSegunda);

        // ── Extracción cerrada de hechos + comparación EN CÓDIGO (2026-07-14) ──
        // El juicio de "fidelidad" del Guardia NO detecta hechos inventados
        // (verificado en vivo: fidelidad=10 a la letra con "Miami" — ver
        // LESSONS.md). Extraer sí es una tarea que el modelo hace bien: acá
        // solo LISTA lugares/personas/fechas que la letra afirma, y
        // compararHechosConEncuesta decide en código si cada uno está
        // respaldado. INFORMATIVO hasta calibrar en el jsonl (protocolo
        // estándar de la Capa 3) — el criterio de graduación a gate/regen
        // automático está documentado en lib/ollama-guardia.js. Con el
        // modelo aún caliente ('5m' de la pasada 2), cuesta segundos.
        const { extraerHechosLetra, compararHechosConEncuesta } = require('./lib/ollama-guardia');
        extraccionHechos = await extraerHechosLetra(
          { letras: parsedJson.letras, titulo: parsedJson.titulo },
          { keepAlive: '5m' }
        );
        if (extraccionHechos.ok) {
          const surveyNames = extractFirstNames(surveyContent);
          hechosSinRespaldo = compararHechosConEncuesta(extraccionHechos, surveyContent, { firstNames: surveyNames });
          console.log(`\n🧾 Extracción de hechos (Ollama/${extraccionHechos.model}, ${Math.round(extraccionHechos.durationMs / 1000)}s): ${hechosSinRespaldo.evaluados} afirmación(es) concreta(s) en la letra.`);
          if (hechosSinRespaldo.sinRespaldo.length === 0) {
            console.log('   ✅ Todas respaldadas por la encuesta.');
          } else {
            for (const h of hechosSinRespaldo.sinRespaldo) {
              console.warn(`   🚨 HECHO SIN RESPALDO en la encuesta (${h.tipo}): "${h.valor}" — ${h.motivo} (informativo — revisar antes de confiar; ver LESSONS.md 2026-07-14)`);
            }
          }
        } else {
          console.log(`\n🧾 Extracción de hechos no disponible (${extraccionHechos.error}) — sin esta señal.`);
        }

        // Desempate: si las 2 pasadas disponibles DISCREPAN en aprobada, una
        // 3ra pasada ciega decide por mayoría — un solo veredicto ruidoso a
        // las 3 AM ya no manda una canción buena a la pausa con timeout (que
        // en --loop la ABANDONA tras 20 min) ni deja pasar una mala.
        if (guardiaSegunda.ok && guardiaResult.aprobada !== guardiaSegunda.aprobada) {
          console.log('\n🛡️  Las 2 pasadas discrepan — tercera pasada de desempate...');
          guardiaDesempate = await consultarGuardia('Desempate', { keepAlive: 0 });
          logPass('El Guardia — desempate (ciega)', guardiaDesempate);
        } else {
          // Las pasadas coinciden o no hubo segunda pasada: descargar modelo manualmente
          if (!isDryRun) {
            fetch('http://localhost:11434/api/chat', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ model: process.env.GUARDIA_MODEL || GUARDIA_DEFAULT_MODEL, messages: [], keep_alive: 0 })
            }).catch(() => {}); // fire and forget
          }
        }
      }

      // Registro SIEMPRE (incluso con el Guardia caído — sin esto, una
      // Ollama muerta tras un reinicio de Windows desaparecía del jsonl en
      // silencio durante semanas y la "red de seguridad" no existía sin que
      // nadie lo supiera). passedQA + qaFailures viajan en cada entrada para
      // poder cruzar el veredicto del Guardia contra el QA duro y el humano.
      if (!isDryRun) {
        try {
          pipelineState.write({ guardia: guardiaResult, guardiaSegunda, guardiaDesempate, hechosSinRespaldo });
          fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
          fs.appendFileSync(
            path.join(__dirname, 'logs', 'guardia-feedback.jsonl'),
            JSON.stringify({ ts: new Date().toISOString(), songId, passedQA, qaFailures, guardiaResult, guardiaSegunda, guardiaDesempate, extraccionHechos, hechosSinRespaldo }) + '\n',
            'utf-8'
          );
        } catch {
          // best-effort — la señal ya se mostró en consola/run-log
        }
      }

      // Gate real ANTES de Suno. `pauseForHumanInteraction` respeta el
      // timeout humano de --loop (20 min default): si nadie responde, esta
      // canción se abandona y el loop sigue con la próxima. Se pausa cuando:
      //   1. El Guardia rechaza por MAYORÍA de las pasadas disponibles
      //      (2-de-2, 2-de-3 con desempate; con una sola pasada disponible,
      //      esa decide; discrepancia sin desempate disponible = pausa, el
      //      lado conservador). Ollama caído del todo nunca bloquea.
      //   2. passedQA=false: la letra quedó con ⚠️ ADVERTENCIA tras agotar
      //      los intentos — con los correctores determinísticos + Haiku esto
      //      ahora es raro, y cuando pasa, mandarla sola a Suno era
      //      exactamente el agujero del bug real 2026-07-13 (una letra con
      //      advertencia llegó hasta el campo de QA sin que nadie la mirara).
      //      La aprobación del Guardia NO anula al validador duro.
      const veredictos = [guardiaResult, guardiaSegunda, guardiaDesempate].filter((g) => g && g.ok);
      const rechazos = veredictos.filter((g) => g.aprobada === false).length;
      const guardiaRechaza = veredictos.length > 0 && rechazos >= Math.max(1, Math.ceil(veredictos.length / 2));
      if (!isDryRun && veredictos.length === 0) {
        await notify(
          `🛡️ "${parsedJson.titulo}": el Guardia (Ollama) no estuvo disponible en ninguna pasada — esta canción sigue SIN segunda opinión. Revisá que Ollama esté corriendo (ollama serve).`,
          { title: 'El Guardia no disponible', priority: 'default', tags: 'warning' }
        ).catch(() => {});
      }
      // estiloSuno vs encuesta (2026-07-13): hoy hardValidate solo chequea
      // que incluya "seseo" (J) — nada juzga si el estilo EN SÍ (género,
      // instrumentación, energía) tiene sentido para la ocasión. Advisory
      // únicamente (ya entra al veredicto general de `aprobada` del Guardia
      // vía las instrucciones del prompt) — se destaca acá para que no quede
      // enterrado entre el resto de `problemas`.
      if (veredictos.some((g) => g.estiloCoincide === false)) {
        console.log(`   🎨 El Guardia dice que el estiloSuno pedido ("${parsedJson.estiloSuno}") no coincide bien con la ocasión/tono de la encuesta.`);
      }

      const pauseReasons = [];
      // Solo fallos de CONTENIDO pausan — "LanguageTool no disponible" es un
      // problema de red con la letra estructuralmente válida: pausar por eso
      // en --loop abandonaría canciones sanas toda la noche por un outage
      // ajeno. Ese caso mantiene el comportamiento de siempre (banner de
      // advertencia + el Guardia informado lo recibe como contexto).
      const contentFailures = qaFailures.filter((f) => !f.startsWith('LanguageTool no disponible'));
      if (!passedQA && contentFailures.length > 0) {
        pauseReasons.push(`quedó con ⚠️ ADVERTENCIA del QA duro (${contentFailures.length} fallo[s]: ${contentFailures.slice(0, 5).join('; ')}${contentFailures.length > 5 ? '; ...' : ''})`);
      }
      if (guardiaRechaza) {
        const detalle = veredictos
          .filter((g) => g.aprobada === false)
          .map((g) => `"${g.veredicto}"${g.problemas.length ? ' — ' + g.problemas.map(formatGuardiaProblem).join('; ') : ''}`)
          .join(' | ');
        pauseReasons.push(`el Guardia la rechazó (${rechazos}/${veredictos.length} pasada[s]): ${detalle}`);
      }
      if (!isDryRun && pauseReasons.length > 0) {
        const motivo = pauseReasons.join(' Y además ');
        await notify(
          `🚨 "${parsedJson.titulo}": frenada antes de Suno — ${motivo}`,
          { title: 'Letra frenada para revisión humana', priority: 'urgent', tags: 'rotating_light' }
        ).catch(() => {});
        await pauseForHumanInteraction(
          `La letra de "${parsedJson.titulo}" ${motivo}. Revisá song.txt antes de continuar con Suno.`
        );
      }
    }

    console.log('\n--- Letra generada ---\n');
    console.log(fullResponse);
    console.log('\n-----------------------\n');

    // Abrir song.txt para revisión (opcional, nunca bloquea). Solo Windows
    // tiene notepad.exe; en macOS se usa `open -e` (TextEdit). El listener de
    // 'error' es obligatorio: sin él, un ENOENT del spawn emite 'error' sin
    // handler y tira una excepción NO atrapada que mataba run.js en Mac
    // DESPUÉS de haber generado bien la letra (auditoría 2026-07-09 — la
    // migración multi-plataforma no había gateado este spawn).
    try {
      const opener = process.platform === 'win32'
        ? spawn('notepad.exe', [SONG_PATH], { detached: true, stdio: 'ignore' })
        : spawn('open', ['-e', SONG_PATH], { detached: true, stdio: 'ignore' });
      opener.on('error', () => {});
      opener.unref();
    } catch {}

    console.log(
      passedQA
        ? '✅ Listo. Revisá song.txt antes de continuar.'
        : '⚠️ Listo, pero con advertencia. Revisá song.txt cuidadosamente antes de continuar.'
    );
  } finally {
    if (isDryRun) {
      try {
        if (dryRunBackedUp) {
          fs.copyFileSync(DRY_RUN_BACKUP_PATH, SONG_PATH);
          fs.unlinkSync(DRY_RUN_BACKUP_PATH);
          console.log('\n🛟 song.txt real restaurado (el mock del ensayo no queda en disco).');
        } else if (fs.existsSync(SONG_PATH)) {
          // No había song.txt real antes del ensayo (primera corrida en esta
          // carpeta) — no dejar el mock tirado como si fuera contenido real.
          fs.unlinkSync(SONG_PATH);
        }
      } catch (e) {
        console.log(`⚠️ No se pudo restaurar song.txt tras el dry-run (${e.message}) — revisar a mano.`);
      }
    }
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
  if (err.noSong) {
    console.log('No hay canciones urgentes en cola en este momento.');
  } else {
    console.error('Automation failed:', err);
  }
  disconnectCdp().finally(() => exitAfterDelay(err.noSong ? 2 : 1));
});
