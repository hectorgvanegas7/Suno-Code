# Lessons / gotchas

## Descarga de Suno fallaba por discrepancia de mtime y SVG bloqueando el botón ⋯ (2026-07-13)

**Bug 1 (mtime):** El servidor de Suno manda un header `Last-Modified` con la fecha exacta de renderizado (ej: `00:44:08`), y Chrome a veces lo preserva como fecha de modificación del archivo en disco. El script usaba `stat.mtimeMs >= downloadStartTime` (donde el start local era `00:44:11`). El desfase de 3 segundos hacía que `findDownloadedFile` descartara el MP3 correcto por considerarlo "viejo".
**Fix 1:** Se añadió una tolerancia de 60 segundos por clock drift: `stat.mtimeMs >= (startTime - 60000)`.

**Bug 2 (SVG path):** El botón `⋯` de la card estaba ocasionalmente cubierto por un `<path>` del SVG de la waveform (z-index issue nativo de la UI de Suno). Esto hacía que `safeClick` agotara intentos y usara `force: true`. El problema es que al forzar el click evadiendo el layout, Radix UI no inicializa bien el menú contextual, y el flyout "MP3 Audio" nunca renderiza.
**Fix 2:** Antes de clickear `⋯`, un `page.evaluate` inyecta `pointer-events: none` recursivo a todos los `<svg>` de la fila de la card. Esto limpia el camino y permite un click natural en el primer intento.
**Fix 3 (JS fallback):** Si por alguna razón el submenú igual falla en mostrar "MP3 Audio" visualmente, se agregó un `page.evaluate` final que busca el botón en el DOM oculto y le hace click directo vía JS (ya que el CDP intercepta igual la descarga generada por JS).

## Falsas alarmas de "Alucinación Grave" por Levenshtein estricto en el cálculo de fidelidad de letra (2026-07-13)

**Bug:** Canciones que sonaban perfectas ("La Pelota Que Se Soltó") sacaban 66%-67% de score y pausaban el script, porque Suno, en su libertad artística, repetía un coro al final, o Whisper entendía "dos años" en vez de "veintidós". El uso estricto de `levenshteinSimilarity` contra todo el texto inflaba la distancia de edición drásticamente al repetirse bloques enteros de texto.
**Fix:** Se reemplazó el cálculo general de Levenshtein por un algoritmo de **Cobertura de Unigramas Difusos** (`calculateLyricsCoverage` en `lib/audio-analysis.js`). Éste cuenta cuántas palabras individuales de la letra original (filtrando conectores cortos) existen en la transcripción, permitiendo pequeños errores de deletreo (1 letra distinta por cada 4). Esto ignora por completo el orden, saltos, estrofas duplicadas o coros extra. Además, se desactivó `condition_on_previous_text=False` en el llamado a Whisper (`lib/transcribe.py`) para evitar que el modelo invente letra sobre pasajes instrumentales basado en sus iteraciones anteriores (y luego se revirtió porque el flag truncaba las canciones prematuramente; los unigramas por sí solos ya solucionan el problema).


## Create DUPLICADO en Suno — el pipeline regeneró y re-envió a Suno una canción que YA estaba lista y subida al Flow, gastando créditos dos veces (2026-07-13, incidente real, plata perdida)

**Qué pasó, en orden:** "Un Ángel en Jenner" llegó hasta subir el MP3 al
Flow y quedó esperando el Auto-Submit (timer de 26-31 min, `--loop`). El
proceso de `start-flow.js --loop --resume` (PID 29272) MURIÓ solo mientras
esperaba (última etapa conocida: "esperando-submit", causa del crash no
confirmada — mismo patrón `3221225786`/`0xC000013A` visto antes con
Ollama). El watchdog lo detectó ~5 min después y relanzó con `--resume`
(`node start-flow.js --loop --resume`, PID 13916). Ese intento de
`--resume` encontró `song.txt` con contenido de OTRA canción (un mock de
`--dry-run` que no se había restaurado a tiempo — corrida manualmente en
paralelo para probar el fix de Guardia, ver la entrada de abajo) y abortó
el resume con un error claro ("song.txt es de otra canción"). Hasta acá,
el diseño funcionó bien — no reprocesó con contenido equivocado.

**El problema real:** `--loop --resume` solo respeta `--resume` en el
PRIMER ciclo (documentado, comportamiento a propósito). Al fallar ese
primer intento, el ciclo 2 arrancó DE CERO, como si fuera una canción
nueva. Pero la asignación de "Un Ángel en Jenner" seguía ACTIVA en el
Flow (nadie había hecho Submit todavía — el timer nunca llegó a
dispararse antes del crash). `enterFlowAndEnsureAssignment` la encontró
("Ya hay una asignación activa en curso, continuando con ella") y
`run.js` procedió a regenerar la letra (usó la caché local, al menos no
gastó una llamada al LLM) y siguió de largo hacia `suno-fill.js` →
Create — **generando 2 versiones NUEVAS en Suno de una canción que ya
tenía sus 2 versiones generadas, subidas y a punto de mandarse a QA**.
Confirmado en vivo: 4 clips de "Un Ángel en Jenner" en Suno (2 originales
de 3:02/3:04, 2 duplicados de 3:12/3:13). Créditos reales gastados sin
necesidad — irrecuperables.

**Por suerte, el Auto-Submit original SÍ había alcanzado a dispararse**
antes de que el proceso muriera (confirmado en "Recent completions" del
Flow: "Un Ángel en Jenner — Completed 07/12/2026, 19:21 PST — 36 min
session"), así que la canción entregada a QA fue la correcta. Lo único
que faltó fue el registro en la hoja (se cortó antes de esa etapa) —
recuperado a mano con `node start-flow.js --done` sin tocar Suno/Chrome
para nada.

**Fix real:** `run.js`, justo después de leer el Song ID de la
asignación activa, ahora chequea `pipelineState.read()` — si el
`songId` coincide con el de `state.json` Y la etapa guardada ya está
más allá de `generated` (`suno-filled`, `flow-filled` o `completed`),
significa que ESTA MISMA canción ya pasó por Suno en esta sesión.
`run.js` aborta fuerte (lanza, nunca sigue de largo) y avisa urgente por
ntfy, en vez de regenerar en silencio. `state.json` es la única fuente
confiable de "hasta dónde llegamos ya" — más confiable que "¿hay una
asignación activa en el Flow?", que no distingue "canción nueva" de
"canción vieja que todavía no se submiteó". `--dry-run` nunca dispara
esto (nunca toca Suno de verdad). Sin test unitario dedicado (la
salvaguarda vive inline en el IIFE principal de `run.js`, no extraída a
una función pura testeable — mismo criterio que el resto de la lógica de
`runFlow`, no unit-testeada directamente); se validó con `npm test`
completo (sin regresiones) y lectura de código.

**Nota para una futura sesión:** esto cierra PARCIALMENTE el gap que
había quedado documentado en la entrada de "`node run.js --dry-run`
corrido directo" de abajo — ahora aunque `--resume` falle y el ciclo
arranque de cero, ya no puede volver a tocar Suno para una canción que ya
lo pasó. Sigue sin resolver: la causa raíz del crash del proceso en sí
(`0xC000013A` recurrente, causa no confirmada) y por qué el mock de
`--dry-run` no se había restaurado a tiempo cuando el watchdog intentó el
resume — probablemente una carrera entre mi corrida manual de prueba y el
timing del watchdog, no reproducida a propósito. Vale la pena, en session
futura: (1) diagnosticar el crash `0xC000013A` de raíz, (2) considerar
si `--dry-run` corrido manualmente debería directamente rechazar correr
si detecta un `--loop` real activo (`logs/watchdog.pid` vivo) en vez de
confiar solo en el backup/restore.

## El Guardia entra también como Capa 4 de QA de AUDIO — segunda opinión semántica contra falsos positivos de Levenshtein/NISQA sobre voz cantada (2026-07-13)

Mismo día que el bug de "Jenner": mientras se esperaba el Auto-Submit de esa
misma canción real, `verify-audio.js` marcó "ALUCINACIÓN GRAVE" en AMBAS
versiones (Levenshtein 59%/67% < 75%) y NISQA muy bajo (23-24/100 en
ambas) — señales que en el diseño actual son "puramente informativas,
nunca deciden solo". Hector escuchó el MP3 real ya subido al Flow: sin
ningún problema. Falso positivo confirmado en vivo, no hipotético.

**Por qué las métricas fallaron:** Levenshtein compara carácter-por-carácter
la transcripción de Whisper contra la letra — no tolera adlibs, alargues de
vocales, repeticiones de estilo libre de canto, todo NORMAL en una canción
cantada real. NISQA (`lib/nisqa_score.py`) nunca se calibró contra voz
CANTADA — está entrenado para voz hablada, así que penaliza duro cualquier
canto con vibrato/sostenido/efectos vocales, que es exactamente lo que
suena bien en una balada real.

**Fix — El Guardia (Ollama) como Capa 4, ahora también para audio:**
`lib/ollama-guardia.js` gana `evaluarAudioGuardia()` (mismo contrato
robusto que `validarGuardia`: nunca lanza, `keep_alive: 0`, `fetchImpl`
inyectable para tests). No puede "escuchar" el MP3, pero SÍ lee la
transcripción de Whisper (que `verify-audio.js` ya generó, cero costo
extra) y la compara SEMÁNTICAMENTE contra la letra pedida, con el prompt
explícitamente advertido de que Levenshtein/NISQA dan falsos positivos
sobre canto y que tolere imperfecciones normales de reconocimiento de voz
cantada. Se llama SOLO cuando ya hay alarma numérica
(`levenshteinScore < 0.75` o `nisqa.score < 50`) — no gasta Ollama en
canciones sanas. Resultado va a `report.guardiaAudio` (y a
`verify-report.json`), impreso en consola con un aviso explícito de
"posible falso positivo" cuando el Guardia aprueba pese a la alarma
numérica.

**Política decidida explícitamente con Hector: PURAMENTE INFORMATIVO, NO
bloquea el Auto-Submit.** Se evaluó la alternativa de que el Guardia
pudiera frenar el pipeline (como el timeout humano en `--loop`) cuando
tanto las métricas como el propio Guardia coincidieran en rechazar, pero
se descartó por ahora — mismo criterio "nunca decide solo" que ya rige
CLAP/NISQA/loudness/pacing en todo el pipeline, hasta calibrar el Guardia
de audio contra casos reales (igual que el Guardia de letra, que tampoco
bloquea). Si en el futuro se calibra bien, es candidato a convertirse en
gate real — documentado acá para no perder el contexto de la decisión.

Tests en `test/ollama-guardia.test.js` (8 nuevos): prompt incluye
letra/transcripción/señales, degrade sin datos, parseo válido/inválido,
`similitud` acotada 1-10, y los mismos casos de robustez de red que
`validarGuardia` (Ollama caído, sin letra pedida).

## `node run.js --dry-run` corrido directo (sin start-flow.js) pisaba song.txt de una canción real en curso — el respaldo/restauración solo vivía en el wrapper (2026-07-13)

Mismo día que el bug de "Jenner" de abajo: para reproducir el bug y probar
el fix con Ollama corriendo, se corrió `node run.js --dry-run` DIRECTO
mientras `start-flow.js --loop` seguía procesando una canción real en
paralelo (misma sesión de Chrome/puerto 9333, distinto proceso Node). El
mock pisó `song.txt` sin ningún respaldo — la protección
("song.txt se respalda antes y se restaura SIEMPRE al final") documentada
en CLAUDE.md solo existía en `start-flow.js`'s `runDryRun()`, nunca en
`run.js` mismo. Se detectó por el `system-reminder` de "song.txt fue
modificado" al leer el archivo después — de no revisarlo, la canción real
en curso hubiera quedado con la letra del mock la próxima vez que algún
paso downstream (`upload-to-flow.js`) leyera `song.txt` de disco.

**Recuperación:** el `song.txt` real completo (con el fix de "Jenner" ya
aplicado) se reconstruyó desde `.cache/<hash>.json` — `run.js` cachea la
respuesta CRUDA del LLM que pasó QA (`lib/cache-helpers.js`) antes de
tocar el archivo, así que el JSON completo seguía disponible aunque el
archivo en disco ya no lo tuviera. Se usó `convertJsonToMarkdown`
(`lib/song-validate.js`, la misma función real que usa `run.js`) para
generar el markdown byte-idéntico al original, en vez de reconstruirlo a
mano — el hash SHA256 coincidió exactamente con el que ya tenía
`state.json` de la corrección manual anterior, confirmando la
reconstrucción exacta.

**Fix real:** se movió el respaldo/restauración de `song.txt` DENTRO de
`run.js` (bloque `try/finally` alrededor de todo el IIFE principal,
gateado por `isDryRun`), para que proteja el archivo sin importar cómo se
invoque el script — ya no depende de que el caller (`start-flow.js`)
recuerde envolver la llamada. `start-flow.js`'s `runDryRun()` YA NO
duplica el backup/restore (hacerlo dos veces sobre el mismo
`song.txt.dry-run-backup` podía romperse: `run.js` limpiaba el backup
antes de que el wrapper externo intentara restaurar el suyo). El chequeo
de "el mock es parseable" también se movió adentro de `run.js` (usa
`parseSongFile` de `lib/song-file.js`, el parser canónico, en vez del
regex ad-hoc que tenía `start-flow.js`) porque para cuando `runScript`
resuelve en el wrapper, `run.js` ya restauró el archivo real — el wrapper
externo ya no puede inspeccionar el mock desde disco.

**Lección general:** cuando una protección de seguridad (backup/restore,
gate de validación) vive solo en el wrapper de orquestación y no en el
script que hace el trabajo real, cualquier invocación directa del script
(debugging, pruebas manuales, otro caller futuro) queda desprotegida.
Ponerla en el nivel más bajo posible (acá, adentro de `run.js`) la hace
imposible de saltear por accidente.

## "Un Ángel en Jenner" — LanguageTool corrigió un lugar real de la encuesta ("Jenner") pensando que era typo, el auto-corrector lo reemplazó por "tener" en la letra (2026-07-13)

La Capa 2 (`lib/languagetool-check.js`) excluía nombres de destinatario
(`extractFirstNames`/`extractLyricNameVariants`/`name-dictionary.json`) pero
NUNCA otros datos factuales reales de la encuesta — lugares, mascotas,
apodos que aparecen en campos como "Special moments together". La encuesta
decía literalmente "un lugar que se llama Jenner" (Jenner, CA, real), el
LLM lo usó bien en la letra, LanguageTool lo marcó como error ortográfico
("Sugerencia: Tener") porque no es una palabra de diccionario, y
`patchSongLines` (el corrector barato) aceptó la sugerencia sin chequear
contra la encuesta — dejando "la orilla del **tener**" y "la arena del
**tener**" en la letra final, que SÍ pasó `hardValidate` de nuevo (es
gramaticalmente válida, solo no tiene sentido factual). Se detectó en vivo,
a mitad de una corrida real de `--loop`, revisando el log en detalle — no
por ningún gate automático.

**Por qué fue peor que el bug de la eñe:** el de la eñe (`ano`→`año`) era
detectable porque "ano" no es la palabra correcta en NINGÚN contexto de esa
letra. Acá el defecto es de fidelidad, no de ortografía — "tener" es una
palabra 100% válida, así que ni el diccionario (Capa 1) ni la categoría
TYPOS de LanguageTool (que ya había "arreglado" el problema, no lo iba a
re-flaggear) lo iban a volver a atrapar. Tampoco es un patrón que
`hardValidate`'s `KNOWN_INCOHERENT` cubra (lista fija de frases, no de
inconsistencias encuesta-vs-letra).

**Fix (mismo criterio de generalización que el bug de la eñe — no una
lista a mano):** `lib/text-helpers.js` → `extractSurveyProperNouns(surveyText)`
extrae TODAS las palabras capitalizadas de la encuesta completa (no solo el
campo de nombre) con un stoplist chico de palabras capitalizadas comunes que
arrancan oración (`El`, `Cuando`, `Nunca`, etc., para no blindar un typo real
que coincida por casualidad con el inicio de una oración de la encuesta).
`run.js` (`runGrammarGate`) las suma a `excludeWords` junto con los nombres
de destinatario ya excluidos. Cualquier palabra capitalizada que la encuesta
mencione literalmente (lugar, mascota, apodo, nombre de una calle, lo que
sea) queda protegida de la "corrección" automática de LanguageTool.
Tests en `test/text-helpers.test.js` con el caso real (["Jenner"]) y un caso
de falso positivo evitado ("El", "Cuando" no se cuelan).

**Recuperación manual de la canción afectada:** el LLM real solo generó UNA
vez ("Jenner" en Verse 1 línea 1 y Outro línea 3, ambos "del Jenner" antes
de la corrupción); se restauró a mano en `song.txt` reemplazando
exactamente el token corrupto ("tener"→"Jenner") preservando el resto de la
línea intacto (el corrector de LanguageTool solo tocó ese span, nunca la
frase completa), y se recalculó `songTxtHash` en `state.json` para que
`checkSongTxtContent` no marque un mismatch espurio.

**Gap que sigue abierto:** el pipeline mató el proceso `start-flow.js`
ENTERO con código `3221225786` (0xC000013A, `STATUS_CONTROL_C_EXIT`) justo
después de guardar la letra corrupta — causa no confirmada todavía (no hay
stack trace, stderr vacío). Si el watchdog llega a relanzar con `--resume`
ANTES de que alguien revise `state.json`/`song.txt`, el `stage: "generated"`
le dice al `--resume` que se salga la regeneración y use la letra tal cual
está en disco — con este bug, eso mandaría la letra rota directo a Suno sin
que nadie la vea. Vale la pena, en una próxima sesión, hacer que
`--resume` re-valide `song.txt` contra `hardValidate` + el gate de
LanguageTool antes de confiar en `stage: "generated"`, no solo el hash.

## MuQ-Eval + Audiobox Aesthetics entran como señales de calidad musical — child_process, NO microservicio, y ojo con los SRCC de papers (2026-07-12)

Se agregaron 2 capas de análisis de audio a verify-audio.js, ambas
PURAMENTE INFORMATIVAS (0 pts en pickBestVersion) hasta calibrar en vivo:
`lib/muq_eval_score.py` (calidad musical percibida, 1-5) y
`lib/audiobox_score.py` (calidad de producción PQ/PC/CE/CU, ~1-10). Cada
corrida queda en `logs/audio-quality-feedback.jsonl` para calibrar contra
oído/REDOs reales.

**Decisión de arquitectura — child_process (spawnSync), NO microservicio
Python residente.** Se evaluó un microservicio local (analogía con
LanguageTool) y se descartó: (1) el patrón spawnSync → JSON por stdout →
graceful degrade ya existe 4 veces (transcribe/clap/nisqa/f0) y funciona;
(2) cada proceso carga el modelo, puntúa y MUERE — la VRAM se libera
garantizado por el OS, mientras que un servicio residente retendría sus
~3GB compitiendo con Whisper large-v3/demucs/CLAP/NISQA por los mismos 8GB;
(3) la analogía con LanguageTool era falsa: acá LanguageTool es una API
pública remota, el repo no administra el ciclo de vida de ningún servicio
local y un microservicio en Windows agrega failure modes (quién lo arranca,
puerto ocupado, zombie tras crash) que el watchdog no cubre; (4) el costo de
recargar el modelo por corrida (~segundos) es irrelevante en un paso que ya
tolera minutos, y se amortiza con UNA invocación batch para A y B.

**Gotcha de papers:** el "SRCC 0.957 con juicio humano" de MuQ-Eval es a
nivel SISTEMA (promediando muchos clips por sistema generador); por clip
individual — que es como lo usa este pipeline, una canción a la vez — el
SRCC real es 0.838. Sigue siendo la mejor señal open-source disponible,
pero las expectativas de calibración van contra 0.838, no 0.957. Misma
lección de siempre: verificar el claim exacto contra el paper antes de
planear alrededor del número de marketing.

**Gotcha de instalación:** MuQ-Eval NO es pip-instalable — es un repo
clonado (`git clone https://github.com/dgtql/MuQ-Eval` + requirements.txt +
`setx MUQ_EVAL_DIR`). Audiobox sí: `pip install audiobox_aesthetics`.
Ambos degradan con gracia si faltan (error por-resultado, pipeline sigue).

**Gotcha de tests (real, de esta misma sesión):** `PYTHON_UTF8_ENV` en
lib/audio-analysis.js es un snapshot de `process.env` tomado al momento del
require — un test que modifica `process.env.PATH` DESPUÉS de requerir el
módulo no afecta a spawnSync. El stub de python de
test/audio-quality-scores.test.js se instala en PATH ANTES del require por
eso, y lee su salida de un archivo (que sí puede cambiar por test).

## "El Guardia" (Ollama local) entra como Capa 3 de QA de letra; "El Técnico" se descarta — y ojo con los nombres de modelos que no existen (2026-07-12)

Hector propuso dos validadores LLM locales vía Ollama: "El Técnico" (validar
que el flujo Playwright/descarga terminó bien) y "El Guardia" (juzgar la
letra en español). Decisiones y por qué:

**"El Técnico" NO se construyó.** Verificar que el MP3 se descargó, que la
duración es válida y que no hubo errores es 100% determinístico y ya existe
en código (`findDownloadedFile`/ffprobe en `lib/audio-analysis.js`, exit
codes en `lib/suno-create-dl.js`). Un LLM ahí es estrictamente peor: agrega
latencia, no-determinismo y un failure mode nuevo (Ollama caído/cargando), y
compite por la misma VRAM de 8GB que necesita el pipeline de audio real. Si
aparece un caso que el código actual no cubre, se resuelve con una regla
determinística nueva, no con un modelo.

**"El Guardia" SÍ** (`lib/ollama-guardia.js` + integración en `run.js`):
coherencia/rima/tono/fidelidad/gancho es genuinamente subjetivo y hasta ahora
solo lo autoevaluaba el mismo modelo que generó la letra (qaChecklist) — no
era una segunda opinión. Arranca PURAMENTE INFORMATIVO (nunca bloquea ni
gasta reintentos), mismo criterio que CLAP/NISQA/loudness: los veredictos se
acumulan en `logs/guardia-feedback.jsonl` + `state.json` para calibrar contra
el QA humano antes de considerar darle poder de gate.

**Gotcha de modelos:** el modelo propuesto originalmente (`qwen3.5:9b`) NO
existe en la librería real de Ollama — verificar SIEMPRE contra
ollama.com/library antes de planear alrededor de un tag. Elegido:
`qwen3:14b` default (q4, 9.3GB — no entra entero en los 8GB de VRAM, Ollama
hace offload parcial a CPU/RAM solo; más lento pero mejor juicio, y Hector
aceptó explícitamente hasta ~30 min por canción). Escape hatch sin tocar
código: `setx GUARDIA_MODEL qwen3:8b` (5.2GB, entra entero, responde en
segundos). `keep_alive: 0` en cada llamada es OBLIGATORIO para que el modelo
se descargue de VRAM apenas responde y no le pise los 8GB a
Whisper/Demucs/CLAP/NISQA más adelante en la misma corrida. `think: false`
porque qwen3 es híbrido con razonamiento y los tokens de "pensamiento"
inflan latencia/pueden romper el parseo (efecto a confirmar en vivo con la
versión de Ollama instalada).

## "Fogata en la Arena" salió con "ano" en vez de "año" y "pequena" en vez de "pequeña" — hardValidate no chequeaba ortografía de palabras comunes (2026-07-11)

El LLM generó la letra con la eñe perdida en dos palabras normales (no
nombres propios) y pasó `hardValidate()` entero: el validador solo chequea
ortografía exacta para nombres propios (`STANDARD_SPANISH_NAMES`/
`canonicalStandardSpanishName`) y una lista fija de frases incoherentes
conocidas (`KNOWN_INCOHERENT`) — nunca existió un chequeo de ortografía para
vocabulario común. "ano" en particular es grave: es una palabra real
distinta ("año" sin la eñe), no un error obvio de spellchecker.

**Fix (primera pasada, insuficiente):** una lista fija de pares conocidos
(`ENYE_TYPOS`) en `lib/song-validate.js`. Funcionaba para "ano"/"pequena"
pero Hector pidió explícitamente generalizarlo — una lista a mano solo
atrapa los casos ya vistos, y "que eso NUNCA FALLE" no se cumple con una
lista curada que se queda corta apenas aparece una palabra nueva.

**Fix real (generalizado):** `lib/spanish-spellcheck.js` — chequeo contra un
diccionario real de español (`nspell` + `dictionary-es`, hunspell, nuevas
dependencias en `package.json`) que cubre CUALQUIER palabra de la letra, no
una lista fija. Estrategia de 2 capas para evitar falsos positivos:
1. Si la palabra ya es válida tal cual (con o sin tilde) se deja pasar —
   cubre ambigüedades reales del español ("mas"/"solo"/"aun", válidas en
   ambas formas) sin forzar una corrección que podría estar mal.
2. Si NO es válida, se generan variantes agregando tilde/eñe en 1-2
   posiciones (a→á, e→é, i→í, o→ó, u→ú, n→ñ); si alguna variante SÍ es
   válida, se marca como probable error y se sugiere esa variante
   ("corazon"→"corazón", "cancion"→"canción", sin necesidad de tenerlas
   en ninguna lista).

Gap real encontrado en pruebas: el propio diccionario a veces reconoce como
"válida" la forma sin eñe/tilde de una palabra porque ES otra palabra real
distinta (ej. "ano" = año sin eñe, pero también es una palabra real en sí
misma; lo mismo con "sueno"/sonar, "montana", "papa"/"mama", "jamas",
"ademas", "ultimo", "publico", "medico") — el paso 1 de arriba las dejaría
pasar sin más. Para esos casos de alto riesgo/alta frecuencia en este
negocio (temática familiar/fe) se mantiene un `ENYE_TYPOS_BLOCKLIST` chico y
curado que fuerza el chequeo igual. Esta lista SÍ sigue siendo manual — no
hay forma de que un diccionario por sí solo distinga intención en un
homógrafo real — pero ahora es solo el backstop para la minoría de casos
ambiguos, no el mecanismo principal.

Registrado como categoría parcheable (`PATCHABLE_FAILURE_PREFIXES`,
`kind: 'enye_typo'`) para que `lib/song-corrector.js` lo arregle con el
modelo barato en vez de forzar un regen completo. Tests en
`test/song-validate.test.js`: el caso real ("ano"/"pequenas"), un caso fuera
de la blocklist para probar que es genuinamente general ("corazon"/
"cancion"), y un caso de palabras ambiguas que NO debe dispararse
("mas"/"solo"/"aun").

## Un diccionario NUNCA resuelve ambigüedad gramatical ("esta" vs "está") — se agregó LanguageTool como Capa 2 (2026-07-11, mismo día que el bug de arriba)

Después de arreglar el bug de "Fogata en la Arena" con `lib/spanish-spellcheck.js`
(diccionario offline), Hector escaló: "que eso NUNCA FALLE", puso en riesgo su
posición en la empresa por esto, y pidió explícitamente evaluar software
especializado. Un diccionario (por más completo que sea) tiene un techo
estructural: "esta" (demostrativo, "esta canción") y "está" (verbo estar,
"esta feliz" debería ser "está feliz") son AMBAS palabras válidas — ningún
diccionario puede saber cuál corresponde sin entender la oración completa.
Ese es exactamente el tipo de error que un negocio de canciones dedicadas no
se puede permitir (suena a error de imprenta en un regalo).

**Fix:** `lib/languagetool-check.js` — integra LanguageTool
(`api.languagetool.org/v2/check`, gratis, sin API key, ~20 req/min de
sobra para 1 canción a la vez) como Capa 2 de defensa, gate async en
`run.js` (`runGrammarGate`, corre DESPUÉS de que `hardValidate` ya dio
`valid:true`). Verificado en vivo con `fetch()` real de Node (¡OJO!: un
test manual con `curl` en Git Bash mojibakeaba los tildes UTF-8 y daba
falsos positivos espurios que no eran reales — usar siempre `fetch()` de
Node para probar esto, nunca curl desde Git Bash en Windows):
- "ano"→"año" vía una regla DEDICADA (`CONFUSIONS/ANO`) — literalmente el
  bug real, LanguageTool ya lo conoce como confusión común del español.
- "corazon"/"pequenas" vía `TYPOS/MORFOLOGIK_RULE_ES`.
- "esta"→"está" vía `DIACRITICS/ESTA_TILDE` — el caso que un diccionario
  simple NUNCA puede resolver.
- 0 falsos positivos sobre letra ya correcta (probado con la letra base del
  fixture de test).
- SÍ da falsos positivos sobre nombres respelleados foneticamente
  ("Maryuri", "Yeovani", "Aandrea" — los toma por errores de ortografía),
  así que el filtro `isExcludedMatch` contra `extractFirstNames` +
  `extractLyricNameVariants` + `lib/name-dictionary.json` es obligatorio,
  no cosmético.

Diseño: solo las categorías `TYPOS`/`GRAMMAR`/`CONFUSIONS`/`DIACRITICS`
cuentan como error duro (`HARD_FAIL_CATEGORIES`) — cualquier categoría de
estilo queda informativa, para no pelear con la licencia poética que el
propio SYSTEM_PROMPT le exige al modelo (mismo criterio que
`checkLoudness`/`pacingIssues` en `lib/audio-analysis.js`). Nunca falla en
silencio: si LanguageTool no responde (red caída, rate limit), la canción
NO se asume limpia — se marca para revisión manual (`grammarResult.
unavailable`) sin gastar los 3 intentos de regeneración completa en un
problema de red que regenerar no arregla. `hardValidate` se mantiene 100%
síncrono/offline a propósito (regla del repo, `test/song-validate.test.js`
sigue sin red) — este gate vive aparte, en `run.js`, async.

Tests 100% offline en `test/languagetool-check.test.js` (matches FAKE con
el shape real verificado en vivo, sin ningún `fetch` real): mapeo de
offset→línea, exclusión de nombres, filtrado por categoría.

Queda documentada en `IDEAS.md` una Capa 3 futura (proofreading LLM
independiente) — no implementada todavía a propósito, para calibrar estas
2 capas reales en producción antes de sumar una tercera señal.

## readRecentCompletion: la alerta de "posible rediseño de UI" disparó 7/7 veces, siempre por el mismo falso positivo benigno (2026-07-10, arreglado tras auditoría de sesión)

Confirmado en vivo en las 7 canciones de la sesión: el timeout de `h3:has-
text("Recent completions")` no era nunca un selector roto — el panel
simplemente no renderiza mientras hay una asignación activa en curso (el
iframe/pestaña muestra la vista "CURRENT ASSIGNMENT" en su lugar). El código
ya distinguía un caso benigno parecido ("no coincide con state.json"), pero
no este.

**Fix:** antes de dejar que el timeout genérico dispare, `readRecentCompletion`
chequea si la página muestra "CURRENT ASSIGNMENT" — si es así, lanza un
mensaje reconocible (`"asignación activa en curso (esperado"`) que el loop de
espera del Submit trata igual que el caso de `state.json`: resetea el
contador de fallos estructurales sin avisar. Verificado en vivo contra el
Chrome real (puerto 9333) con una asignación activa cargada — el body
contiene "CURRENT ASSIGNMENT" y CERO menciones de "Recent completions",
exactamente el patrón esperado.

## NISQA fallaba 7/7 veces en canciones reales — "Maximum number of mel spectrogram windows exceeded" (2026-07-10, arreglado tras auditoría de sesión)

Las 7 canciones de la sesión del `--loop` de esta noche fallaron NISQA con el
mismo error, sin excepción — no era un caso aislado, era estructural:
cualquier canción de duración completa (~3 min) excede el límite interno del
modelo (`NonIntrusiveSpeechQualityAssessment` de torchmetrics), que espera
clips bastante más cortos. La señal complementaria a CLAP nunca estuvo
disponible en producción desde que se agregó.

**Fix:** `lib/nisqa_score.py` — en vez de pasarle el audio completo al modelo
de una sola vez, se corta en ventanas de `MAX_CHUNK_SECONDS` (10s, valor
conservador sin un límite documentado exacto), se puntúa cada ventana por
separado y se promedian los resultados (`mos` + las 4 dimensiones). Si algún
chunk individual falla, se descarta y se promedia con los que sí funcionaron
— solo lanza error si NINGÚN chunk pudo evaluarse. Confirmado en vivo contra
"Veinticinco Veranos.mp3" (3:03, 19 chunks, 0 fallidos) — antes tiraba el
error de siempre, ahora da `nisqa_score: 18` real.

**Nota de calibración (sin resolver todavía):** el score que dio (18/100,
MOS 1.74) es bajo — puede ser una señal real (voz con artefactos) o puede
que ventanas de 10s sean demasiado cortas para que el modelo puntúe bien
(NISQA fue entrenado típicamente sobre clips de cierta duración, no
necesariamente 10s). Igual que CLAP y el resto de las señales nuevas del
proyecto, esto sigue siendo informativo/no calibrado — el arreglo de esta
sesión fue que la señal EXISTA, no que sus números ya estén validados de
oído.

## Verificación de subida al Flow: falso negativo por timing + el gate del Auto-Submit no la leía (2026-07-10, en vivo, 2/2 canciones)

`upload-to-flow.js` avisó "No se pudo confirmar que el archivo quedó en la UI"
en dos canciones seguidas ("El Día Que No Hablamos" y "La Bata Larga de
Esperanza"). Verificado en vivo por CDP las dos veces: el archivo SÍ se había
subido correctamente (`<audio src>` con URL de Supabase y timestamp fresco),
solo que minutos después de que el chequeo ya había fallado.

**Causa raíz:** el chequeo corría UNA sola vez, 2 segundos fijos después de
`setInputFiles()` — insuficiente para que el servidor del Flow procese la
subida y actualice el DOM. **Fix:** reemplazado por un poll de hasta 12s
(1s entre intentos) en vez de un intento único.

**El hallazgo más importante estaba un nivel más arriba:** este chequeo
(`uploadConfirmed`, variable LOCAL de `upload-to-flow.js`) nunca afectaba el
`uploadConfirmed` que usa `start-flow.js` para decidir si arma el Auto-Submit
— ese otro `uploadConfirmed` solo verifica que el proceso hijo no haya
lanzado una excepción (exit code 0). Dos variables con el mismo nombre,
significados distintos, y solo la segunda importaba. Si la subida real
hubiera fallado en silencio, el gate documentado en CLAUDE.md ("el Auto-Submit
solo dispara si se subió y confirmó un MP3") no lo habría detectado.
**Fix:** cuando el poll de 12s se agota sin confirmar, ahora se llama
`pauseForHumanInteraction` (mismo fallback que un error real de subida) en
vez de solo loguear un warning y seguir — en `--loop` esto abandona la
canción por timeout humano en vez de auto-submitear una subida sin verificar.

**Takeaway:** un mismo nombre de variable en dos archivos distintos con
significados distintos es una trampa — "confirmado" en un proceso hijo no
significa nada para el proceso padre a menos que el resultado viaje
explícitamente entre ellos (acá, vía exit code + pauseForHumanInteraction).

## "Jesús" respelleado a "Yeous" — la regla de fonética se aplicaba a nombres españoles ya correctos (2026-07-10, "El Aire Que Respiro", en vivo)

Segunda vez que pasa lo mismo (la primera fue "Jeremías" → "Yeremías",
detectada y corregida antes en la sesión — ver memoria de usuario). Esta vez
"Jesús Alejandro" salió como "Yeousalejandro" en el Chorus 1 y 2 de una
canción real, ya subida a Suno. Hector lo vio en la letra generada y pidió
explícitamente NO parchear el caso puntual sino generalizar la regla para
que la clase entera de error no vuelva a pasar.

**Causa raíz:** la sección `PHONETIC RE-SPELLING FOR SUNO` del
SYSTEM_PROMPT (run.js) decía "si un nombre tiene J/Y que suena a inglés,
respelléalo" sin excluir nombres que YA son español estándar. Los ejemplos
de la regla (Johelyn, Dayana, Brayan, Geovanny, Jhoselyn, Shirley, Maryuri)
son todos anglicismos/ortografías inventadas — pero el modelo generalizó de
"nombres con J que Suno pronuncia mal" a "cualquier nombre con J", incluyendo
nombres españoles reales donde la J ya suena bien (Jesús, Jeremías, José,
Juan...).

**Fix:** regla dura agregada al inicio de la sección en run.js: nunca
respellear un nombre que ya es español estándar/inambiguo (con ejemplos
explícitos: Jesús, José, Juan, Jorge, Javier, Jeremías, Josué, Julio), y
aclarado que la sección entera solo aplica a nombres anglicanizados o con
ortografía inventada que no existe en español estándar. Además,
`lib/name-dictionary.json` gana `"jesus"/"jesús": "Jesús"` (candado de
identidad, mismo patrón que `"jeremias"`) como red de seguridad adicional
vía el mecanismo de REGLA ESTRICTA (gana sobre las reglas generales del
prompt aunque el modelo vuelva a fallar).

**Takeaway:** cuando el mismo tipo de error aparece dos veces con nombres
distintos, no es una casualidad de un nombre puntual — es la regla general
la que está mal calibrada. Un diccionario de candados por nombre (Jeremías,
Jesús, ...) tapa casos ya vistos, pero solo arreglar la regla del prompt
previene los que todavía no vimos.

## f0Gender reportaba "Femenina" con confianza para una voz masculina real — error de octava sobre la voz aislada por demucs (2026-07-10, "Mi promesa", en vivo)

Corrida `--loop` sin `--pause`: `verify-report.json` marcó `f0Gender.mismatch: true`
en A y B ("Femenina" detectada, 235.7/263 Hz, contra "Masculina" pedida en
song.txt) para "Mi promesa". Como `f0Gender` es puramente informativo (0 puntos
en `pickBestVersion`), no bloqueó nada y la canción se subió y auto-submiteó
sin que nadie lo viera. Horas después Hector escuchó el MP3 real: la voz era
claramente masculina.

**Diagnóstico en vivo:** corriendo `lib/f0_gender_check.py` directamente sobre
el MP3 completo (mix, sin aislar) en vez de la voz aislada por demucs, dio
116.5 Hz y 117.2 Hz — "Masculina" en las dos, coincidiendo con lo escuchado.
Exactamente la mitad del F0 reportado sobre la voz aislada: un error clásico
de octava (pyin bloqueando el 2do armónico en vez del fundamental real),
específico de correr sobre el stem separado por demucs — no del mix.

**Fix (v1):** `reconcileF0Octave` (lib/audio-analysis.js) — el chequeo de F0
ahora corre sobre la voz aislada Y sobre el mix completo (mismo proceso,
batch). Si ambos difieren por un factor cercano a una octava (0.43–0.59x o
1.7–2.35x), se reporta `detectedGender: "Indeterminado"` con
`octaveConflict: true` y ambos valores a la vista.

**Se escapó un caso esa misma noche (2026-07-10, "Sábado Veinte de
Septiembre", en vivo):** Versión B dio voz aislada 263 Hz vs. mix 94.3 Hz —
ratio 2.79x, fuera de la ventana 1.7–2.35x porque el mix TAMBIÉN viene
sesgado (hacia abajo, por el bajo/instrumentos — auditoría 2026-07-09), así
que el desfase entre dos mediciones cada una con su propio sesgo no cae en
una octava limpia. Se reportó "Femenina" con confianza otra vez, sin que el
v1 del fix lo atajara. Confirmado de nuevo corriendo `f0_gender_check.py`
sobre el mix a mano: 94.3 Hz → Masculina, coincide con la voz real.

**Fix (v2, el que quedó):** en vez de exigir un ratio numérico específico,
`reconcileF0Octave` ahora solo compara las clasificaciones CATEGÓRICAS
(Masculina/Femenina) de la voz aislada y el mix — si discrepan, sea cual sea
el ratio exacto, es `"Indeterminado"`. Regresión fijada en
test/audio-analysis.test.js (187 tests) — incluye el caso de 2.79x que el v1
se perdía.

**Takeaway:** una señal "informativa" que se imprime con la misma confianza
que una medida verificada es indistinguible de un dato real hasta que alguien
la contrasta de oído — igual al patrón de "más de vos" (ver más abajo) y al
del selector "More from Suno": un chequeo que puede estar sistemáticamente
mal necesita su propio chequeo cruzado antes de aparecer como texto plano en
un reporte, no alcanza con marcarlo "no calibrado" en un comentario.

## Suno renombró el aria-label del botón "⋯" — Download MP3 fallaba para A y B (2026-07-09, en vivo, madrugada)

Loop nocturno abandonó una canción tras 20 min: "No se pudo clickear Download
-> MP3 Audio" para la versión A y luego para la versión B (dos avisos ntfy,
3:59am y 4:02am). `clickDownloadMp3` (lib/suno-create-dl.js) no encontraba el
botón de opciones de la card porque Suno cambió `aria-label="More options"` a
`aria-label="More from Suno"` — `MORE_OPTIONS_MENU_ARIA_SELECTOR` en
lib/suno-selectors.js apuntaba al valor viejo. `suno-selector-drift.js` no
había detectado esto (no se corrió después del cambio de Suno). Confirmado
con evidencia de DOM en vivo (Antigravity, conectado al Chrome del puerto
9333) antes de aplicar el fix. Fix: selector actualizado en
lib/suno-selectors.js. El fallback a `pauseForHumanInteraction` sí funcionó
como diseñado (no mató el proceso, avisó y esperó) — pero nadie estaba
despierto a las 4am, así que la canción se abandonó por timeout como corresponde.

En la misma madrugada, `readRecentCompletion` (start-flow.js, selector
`.rounded-xl:has(.font-medium.text-slate-900)`) también tiró timeout
("Auto-detección del Submit con problemas", 4:15am) — verificado en vivo que
el selector NO cambió (mismo DOM que siempre). Causa más probable: el panel
"Recent completions" estaba genuinamente vacío en ese momento puntual
(latencia del backend de Suno/Flow en registrar la canción recién
completada), no un rediseño de UI. No requiere fix de selector; si se repite
seguido conviene revisar si el timeout de 10s de esa espera es corto para la
latencia real del panel.

## El "fix" del aria-label de la madrugada estaba mal — "More options" era correcto todo el tiempo (2026-07-09, tarde, en vivo)

El loop nocturno volvió a trabarse en el mismo fallback ("No se pudo abrir el
menú ⋯ de la card... tras 3 intentos") horas después del fix de la entrada
anterior, que había cambiado `MORE_OPTIONS_MENU_ARIA_SELECTOR` de
`[aria-label="More options"]` a `[aria-label="More from Suno"]`.

Diagnóstico en vivo contra el Chrome pausado del puerto 9333
(`suno-selector-drift.js` + un probe directo por CDP): `[aria-label="More
from Suno"]` matcheaba UN SOLO botón en toda la página, no relacionado con
ninguna card (`0/15` clip-rows). `[aria-label="More options"]` seguía
matcheando **15/15** cards — el botón real nunca cambió de aria-label. El fix
de la madrugada se aplicó sin verificar en vivo que el selector nuevo
matcheara filas reales, solo que "algo" existía con ese texto en el DOM.

**Fix:** revertido `MORE_OPTIONS_MENU_ARIA_SELECTOR` a `[aria-label="More
options"]` en `lib/suno-selectors.js`.

**Takeaway:** un selector "corregido" que matchea 1 elemento fuera de las
cards es peor que uno roto — pasa un chequeo superficial ("existe en el DOM")
sin resolver nada. Cualquier fix de selector de card debe confirmar el conteo
de matches CONTRA las filas reales (`row.locator(...).count()` por cada
`clip-row`), no solo `page.locator(...).count()` global.

## "más de vos" con trato tú llegó al AUDIO generado — hardValidate nunca validó el trato tú (2026-07-09, "Luz Que No Buscaba", en vivo)

Primera corrida observada en vivo tras la auditoría: encuesta con trato "Tú",
y el Verse 1 cerró con "Cuando te fuiste de ahí yo quise saber más de VOS".
Pasó TODA la cadena (checklist del modelo ✓ en trato_consistente,
hardValidate limpio, Suno generó el audio cantándolo) y se frenó A MANO ~14
min antes del Auto-Submit. Créditos gastados en una letra inaceptable.

**Por qué "nunca había pasado" y ahora sí (dos causas que se juntaron):**
1. **El chequeo de mezcla de trato SOLO existía para trato "usted"** — para
   tú y vos no había NINGUNA validación dura, desde siempre. El hueco estaba
   tan naturalizado que los propios fixtures de test tenían "Sos ejemplo puro
   de humanidad" (voseo) con trato tú en SIETE lugares y nadie lo vio nunca.
2. Las reglas nuevas de composición del 2026-07-07/08 (rima fuerte AABB/ABAB
   + vocales abiertas al final de línea) empujan al modelo a rimar con
   -os/-oz ("voz", "dos", "sol") — y "vos" es la rima perfecta. La presión
   nueva del prompt EXPUSO el hueco viejo del validador. Exactamente el
   patrón contra el que avisa la regla de mantenimiento de CLAUDE.md ("cada
   regla nueva del SYSTEM_PROMPT debe chequearse contra el validador"): las
   reglas de rima entraron sin preguntarse qué podían romper.

**El checklist del modelo NO es defensa:** se auto-calificó ✓ en
trato_consistente con el "vos" adentro. La auto-evaluación del LLM es
orientativa; lo duro tiene que vivir en hardValidate.

**Fix (tres capas, pedido explícito de Hector: REGLA INQUEBRANTABLE):**
1. `hardValidate` sección I generalizada a los TRES tratos
   (`TRATO_MISMATCH_MARKERS` en lib/song-validate.js): tú → voseo (vos, sos,
   tenés, podés...), vos → tuteo exclusivo (contigo, eres, tienes, ti...),
   usted → lo de siempre. Mismos límites acentuados (nunca \b).
2. Regla 3 del SYSTEM_PROMPT reforzada con la prohibición ABSOLUTA explícita
   + el anti-ejemplo real ("más de vos") + "las reglas de rima NUNCA pisan
   esta regla: reescribí la línea entera".
3. `FATAL_FAILURE_PATTERNS` en run.js: si una mezcla de trato sobrevive los
   3 intentos de regeneración, run.js ABORTA (exit ≠ 0, ntfy urgente, cero
   créditos) en vez de continuar con el banner de advertencia — el banner
   con --loop de noche no lo lee nadie. Extensible a otras categorías
   inaceptables agregando un patrón a la lista.

**Regresión fijada** en test/song-validate.test.js con la línea exacta del
incidente + voseo verbal + falsos positivos ("versos" contiene "sos") + vos
declarado con tuteo. Tests 176 → 180.

**Takeaway:** un validador que solo cubre UNA rama de una regla de tres ramas
no es cobertura parcial — es una promesa falsa de cobertura. Y cuando el
prompt gana reglas que incentivan un patrón (rima en -os), revisar qué
palabra "prohibida" es justo la que mejor satisface el incentivo.

## Auditoría adversarial 2026-07-09 (Fable): el watchdog mataba pipelines sanos, el Auto-Submit no chequeaba el upload, y las notificaciones con emoji nunca llegaron

Auditoría independiente de los ~8 commits del bulletproofing nocturno +
tanda completa de fixes (tests 156 → 176+, dry-run limpio). Los bugs reales
que importan para no repetirlos:

1. **El heartbeat solo latía en 2 loops (poll y espera del Submit) — el
   watchdog mataba un pipeline SANO a mitad de cada canción.** Entre que el
   poller agarra una canción y llega la espera del Submit pasan 15-40 min
   (run.js, suno-fill, Create+generación+descarga de hasta 8 min, demucs)
   sin un solo latido; el watchdog declaraba colgado a los 5 min. Peor: tras
   el relanzamiento, el heartbeat VIEJO seguía en disco → cada tick
   siguiente relanzaba OTRO pipeline (cascada de hasta 3 procesos
   concurrentes antes del breaker), y un heartbeat de anoche al arrancar
   --loop duplicaba el pipeline desde el minuto cero. **Fix:**
   `createStageHeartbeat` (lib/heartbeat.js) — ticker de 30s durante todo
   runFlow con TECHO por etapa (si la etapa excede su techo, deja de latir a
   propósito y el watchdog actúa: los hangs reales se siguen detectando);
   latido inicial al arrancar --loop; el watchdog refresca el heartbeat con
   el pid nuevo al relanzar. **Regla:** cualquier fase nueva de runFlow que
   pueda superar 5 min necesita su hb.setStage() con un techo mayor al
   timeout humano de 20 min.

2. **El Auto-Submit disparaba aunque el upload hubiera fallado o no
   existiera ningún MP3** — en un REDO eso re-manda a QA exactamente la
   versión vieja ya rechazada (redo sin cobrar). Ninguna rama de fallo
   (upload lanzó, Create falló 3 veces, --resume sin archivos) apagaba el
   timer. **Fix:** gate `uploadConfirmed` — sin MP3 confirmado en ESTA
   corrida no se submitea, avisa urgente con los pasos manuales y la
   detección del Submit manual sigue activa. **Regla:** todo disparo
   automático irreversible necesita como precondición el ÉXITO verificado
   del paso del que depende, no solo que "el pipeline llegó hasta acá".

3. **Las notificaciones con emoji en el título NUNCA llegaron.** lib/ntfy.js
   mandaba el título como header HTTP y fetch() de Node exige headers
   ByteString (Latin-1): cualquier emoji fuera de Latin-1 (🛑 🔄 ⏱️ ⚠️ ✋ 🌙)
   tiraba TypeError ANTES de tocar la red y el catch mudo se lo tragaba —
   justo las notificaciones más críticas (watchdog, circuit breaker, timeout
   humano, digest) fallaban el 100% de las veces, en silencio, desde
   siempre. **Fix:** API JSON de ntfy (UTF-8 completo) + una línea de log
   cuando un envío falla. Regresión fijada en test/ntfy.test.js. **Regla:**
   un catch 100% mudo alrededor de I/O "best-effort" esconde bugs
   sistemáticos — loguear al menos una línea; y cualquier string que viaje
   en un header HTTP es Latin-1, no UTF-8.

4. **`--loop` ignoraba `--resume` (hard-coded `resume: false`)** — el
   relanzamiento `--loop --resume` del watchdog nunca resumía: re-corría
   run.js desde cero (re-gasta la llamada LLM; un REDO no tiene caché) y
   dependía solo de la salvaguarda anti-doble-Create. **Fix:** --resume vale
   para el primer ciclo del loop.

5. **Ctrl+C sobre --loop dejaba al watchdog vivo → "resucitaba" el pipeline
   apagado a propósito** ~5-7 min después. **Fix:** handler de SIGINT/SIGTERM
   en --loop que apaga el watchdog (`stopWatchdogIfRunning`) y borra el
   heartbeat; el watchdog además es singleton y limpia su pidfile al morir
   por señal (el evento 'exit' NO corre con el handler default de SIGINT).

6. Menores de la misma tanda: el "resumen matutino" se mandaba al primer
   tick si el watchdog arrancaba después de las 7am (o sea, siempre que se
   lanzaba de noche) — ahora exige que venga corriendo desde antes de las 7
   (`shouldSendDigest`, testeada); antes de matar un PID se verifica que sea
   Node (Windows recicla PIDs — nunca taskkill a un proceso ajeno); el
   circuit breaker tiene respaldo en memoria (disco lleno no lo desactivaba);
   todo arranque de start-flow (incluido --dry-run) flusheaba la cola real de
   la galería — ahora --dry-run no lo hace (misma clase de bug que "npm test
   pegaba a Drive real", 2026-07-07); `spawn('notepad.exe')` sin gate de
   plataforma ni listener de 'error' mataba run.js en Mac DESPUÉS de generar
   bien la letra; `detectTruncatedWords` era ciega a su caso motivador
   ("Fran-" conserva la vocal cantada larga — la duración no delata el corte,
   la caída de volumen sí; rediseñada con probability como gate y
   duración/volumen como confirmación); F0 sobre el mix completo (sin demucs)
   reportaba un género basura con apariencia de dato — ahora solo corre sobre
   voz aislada; loudness/f0Gender/truncatedWords no se escribían en
   verify-report.json (solo consola); los clips de name-check/ y
   truncated-words/ no rotaban nunca; el mock de --dry-run validaba contra la
   survey.txt real → advertencia falsa en cada ensayo (ahora hay MOCK_SURVEY
   consistente y el dry-run pasa limpio); el listener de descarga se armaba
   una sola vez antes del bucle de reintentos y su timeout de 20s expiraba
   antes del click real; CLAUDE.md seguía afirmando saveAs()+paralelo (ver
   2026-07-07 #3 — ahora doc y comentarios describen el mecanismo real).

## Auditoría 2026-07-07: npm test pegaba a Drive real, doble-Create latente, saveAs() nunca se usó, state.json no atómico

Auditoría completa de solo-lectura (Claude, 3 barridos paralelos) + tanda de
fixes de bajo riesgo. Los hallazgos que importan aunque no se toquen todavía:

1. **`npm test` NO era offline.** El script era `node --test` sin path, y el
   runner de Node matchea `*-test.js` en cualquier carpeta — `upload-test.js`
   (experimento suelto en la raíz) entró a la suite e hizo una subida REAL a
   Drive + galería ("Fila 177", 2026-07-07) durante una corrida de tests.
   **Fix:** `"test": "node --test test/"`. **Regla:** ningún script con
   side-effects de red puede llamarse `*-test.js`/`*.test.js` fuera de
   `test/`; los experimentos van a `experiments/`.

2. **Ventana de doble-Create (créditos duplicados), SIN fix todavía.**
   `waitForCreateStarted` espera cards nuevas solo 20 s
   (`CREATE_CARDS_TIMEOUT_MS`). Si Suno tarda más en insertar la primera
   card, el código reintenta con `jsClickCreate` — si el primer click SÍ
   había registrado, son 2 generaciones pagadas (el código solo advierte
   "algo clickeó de más"). No existe una etapa `CREATE_CLICKED` en state.json
   que bloquee un re-click. Pendiente de diseño (toca lógica central).

3. **La descarga NO usa `download.saveAs()`, aunque los comentarios del
   propio archivo, CLAUDE.md y la lección de la migración 2026-07-04 dicen
   que sí.** El objeto `Download` solo se usa para `.failure()`; el archivo
   real se localiza escaneando el directorio por título+mtime
   (`findDownloadedFile`) + `renameSync`. Funciona porque el loop de
   descargas es SECUENCIAL (cada descarga se reclama/renombra antes de la
   siguiente) — contrato ahora documentado en
   `test/find-downloaded-file.test.js`. Reconciliar código vs. docs queda
   pendiente (lógica central). **Regla:** cuando una migración se documente
   como completa, verificar que el código viejo se haya ido de verdad.

4. **`state.json` se escribía sin atomicidad** (`writeFileSync` directo). Un
   crash a mitad de write deja JSON truncado, `read()` devuelve `null` en
   silencio, y con eso se apagan la salvaguarda anti-Create-duplicado y la
   auto-detección del Submit. **Fix:** `atomicWriteJson` (tmp + rename) en
   `lib/pipeline-state.js`, cubierto en `test/atomic-state-write.test.js`.

5. **La salida de los scripts Python se emparejaba por índice a ciegas.**
   `transcribeFiles`/CLAP/NISQA parsean la última línea de stdout y asumen
   que `results[i]` corresponde a `paths[i]` — un reorden u omisión cruzaba
   los resultados de A y B en silencio (la recomendación de `pickBestVersion`
   saldría de la versión equivocada). **Fix:** `batchFileMismatch` compara
   `result.file` contra el path esperado y falla ruidoso por-resultado.
   Cubierto en `test/python-batch-order.test.js`.

6. Fixes menores de la misma tanda: fd del log de verify-audio sin cerrar
   (fuga por corrida en `--loop`); el iframe de monitoreo quedaba VISIBLE
   tapando la pestaña de trabajo si el screenshot de la card lanzaba
   (restauración movida a un `finally`); `suno-fill.js`/`suno-create.js`
   salían con `process.exit(1)` en el mismo tick (crash de libuv en Windows —
   mismo patrón ya arreglado en upload-to-flow.js); `suno-create.js` y los
   fallbacks de reintento de Create clickeaban sin dismiss fresco de
   overlays (la regla es "antes de CADA click", no solo el primero); el
   campo de notas del Flow no tenía `waitForSelector` propio (regla de
   secciones dinámicas); el loop infinito de detección del Submit ahora
   avisa por ntfy si acumula ~3 min de fallos ESTRUCTURALES consecutivos
   (los "título aún no coincide" de la espera normal no cuentan) — sigue
   sin deadline, por diseño.

7. **NISQA no corre en producción** desde que se integró: falta
   `pip install torchmetrics` (visible en el `error` de cada
   verify-report.json). Instalarlo está pendiente de OK.

## STYLE_TEXTAREA roto: Suno rotó el placeholder de ejemplo, ya no contiene "style" (2026-07-04)

Primer uso real del flujo "Antigravity ejecuta reconocimiento acotado,
Claude revisa y aplica el fix" (ver memoria `feedback_antigravity_as_tool`).
Antigravity corrió un detector de drift de selectores (solo lectura, sin
clicks) contra una sesión real de Suno y reportó `STYLE_TEXTAREA` roto. Se
verificó en vivo (Chrome abierto de nuevo, mismo patrón CDP): el placeholder
del textarea de estilo pasó de tener la palabra "style" literal a un ejemplo
rotativo de géneros ("concertina, cafe music, british invasion, strong
vocal, hand drum") — el regex viejo (`textarea[placeholder*="style" i], ...`)
dejó de matchear cualquier cosa.

**Fix:** el textarea vive dentro de un wrapper con
`data-testid="create-form-styles-wrapper"` que SÍ es estable (no depende del
placeholder de ejemplo). Confirmado en vivo que resuelve a exactamente 1
elemento, el correcto. `STYLE_TEXTAREA` ahora ancla ahí en vez del
placeholder.

**Takeaway sobre selectores de UI de terceros:** cualquier selector basado
en placeholder/texto de ejemplo es más frágil que uno basado en
`data-testid`/`aria-label` estructural — Suno puede rotar el texto de
ejemplo (probablemente A/B testing o solo variedad) sin que sea un
"rediseño" real. Cuando un selector de este tipo se rompe, buscar primero un
contenedor/wrapper con testid estable antes de escribir otro regex de texto
que puede volver a romperse con la próxima rotación.

**Sobre el flujo con Antigravity:** se mantuvo dentro de las reglas (cero
clicks, cero ediciones de lógica de negocio, solo generó 2 archivos nuevos +
un reporte). El único ajuste de housekeeping necesario: `scratch_check.js`
(su script de diagnóstico ad-hoc) no matcheaba el patrón `scratch-*` del
`.gitignore` (guion bajo vs. guion medio) — borrado tras extraer el dato que
tenía adentro. `selector-drift-report.md` se agregó al `.gitignore` (es una
foto de un momento del DOM, se pisa en cada corrida — mismo criterio que
`verify-report.json`).

## Nota del Flow perdía la línea estándar en cada REDO (2026-07-03/04)

`flow-submit.js` construía la nota estándar ("`<fecha>. Hector. PS0180. Letra
+ Suno.`", de la línea NOTES de song.txt) y después, si `state.json` marcaba
`isRedo`, la REEMPLAZABA por completo con solo `'Redo Fix, corregido'` —
perdiendo la fecha/Hector/PS0180 en cada REDO real (confirmado en vivo: el
campo de Notas del Flow quedó con únicamente "Redo Fix, corregido" para "Mil
Veces Tú"). El formato correcto (pedido directo de Hector) es la nota
estándar SIEMPRE, con "Redo Fix, corregido" agregado DEBAJO cuando aplica.

**Fix:** `buildRedoAwareNotes(rawNotes, { isRedo })` en `lib/song-file.js`
(nueva, junto a `buildFlowNotes` — antes vivía inline en flow-submit.js, no
testeable). Cubierta en `test/song-file.test.js`.

## Investigación de mojibake en CLAP + crash de Whisper en vivo (2026-07-03/04) — fix defensivo aplicado, causa exacta no 100% confirmada

En el mismo run real, `verify-audio.js --demucs` reportó dos fallos:
Whisper crasheó con un traceback de Python (mensaje truncado en el log a
"File \"...cancionete", inútil para diagnosticar), y CLAP no encontró el
archivo porque el nombre le llegó como `Mil Veces TÃº.mp3` en vez de
`Mil Veces Tú.mp3` (mojibake clásico de UTF-8 mal decodificado como
Latin-1/cp1252).

**Intento de reproducir, honestamente reportado:** correr `transcribe.py`
directo (CPU/small y CUDA/large-v3) contra el mismo MP3 real terminó OK, sin
crash — así que el bug de Whisper no está en `transcribe.py` en sí, sino
específicamente en el camino `--demucs` (archivo intermedio `vocals.wav` en
un temp dir que se borra en el `finally`, no se pudo reproducir después).
Un test aislado de round-trip stdin (Node spawnSync → Python `json.loads`)
con el mismo nombre acentuado **no reprodujo el mojibake** en este sistema —
sugiere que este Python ya usa UTF-8 por default acá (probable modo UTF-8 de
Python moderno), así que la causa exacta del mojibake visto en vivo sigue sin
confirmarse al 100%.

**Fix aplicado de todas formas (defensivo, sin downside):** `PYTHON_UTF8_ENV`
en `lib/audio-analysis.js` — `PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8` en el
`env` de ambos `spawnSync` (Whisper y CLAP). Es la práctica estándar para
subprocesos Python en Windows con nombres de archivo con tildes/ñ, y no
depende de qué versión de Python esté instalada. Si el mojibake vuelve a
aparecer, la siguiente hipótesis a probar es normalización Unicode NFC/NFD
(un "ú" precompuesto vs. descompuesto puede fallar un `os.path.exists()` en
Windows aunque se vea idéntico).

**Mejora real y confirmada, de paso:** los mensajes de error de Whisper/CLAP
mostraban la PRIMERA línea del stderr (`"Traceback (most recent call
last):"`, inútil) en vez de la última (el tipo+mensaje real de la excepción).
Nueva `lastMeaningfulLine()` en `lib/audio-analysis.js` — usada en ambos
lugares, cubierta en `test/audio-analysis.test.js`. La próxima vez que esto
falle, el log va a decir algo diagnosticable en vez de un traceback cortado
a la mitad.

## Descarga de A y B en serie desperdiciaba hasta 8 min por versión sin necesidad (2026-07-03/04)

Corrida en vivo real: la Versión A se descargó rápido, pero B esperó los 8
minutos completos y falló — visible dos veces en la misma noche. Root cause
de diseño (no un bug de UI): `createAndDownload` procesaba cada versión de
punta a punta antes de pasar a la siguiente — clickear "MP3 Audio" para B ni
arrancaba hasta que la descarga ENTERA de A hubiera terminado (hasta 8 min).
Pero Suno ya generó ambas cards en simultáneo — no hay ninguna razón real
para esperarlas en serie, solo el click en sí es secuencial (misma pestaña,
no se pueden abrir 2 menús a la vez).

**Fix:** separado en dos fases en `lib/suno-create-dl.js`:
1. `clickDownloadMp3` — solo clickea (secuencial, rápido, segundos).
2. `awaitClickedDownload` — espera el archivo. Se corre en **paralelo** para
   A y B con `Promise.allSettled` (cada watcher ya tiene su propio timeout de
   8 min independiente, así que no se pisan entre sí).

**Cuidado real encontrado al paralelizar:** el fallback manual
(`pauseForHumanInteraction`, para cuando ni siquiera se pudo clickear)
escucha `process.stdin.once('data', ...)` — si dos versiones caen a este
fallback en paralelo, un solo ENTER del humano resolvería AMBAS esperas de
golpe, aunque solo haya terminado una descarga manual. Por eso
`awaitManualDownload` (el fallback) se mantiene deliberadamente SECUENCIAL en
el caller, nunca dentro del `Promise.allSettled` — solo las descargas que sí
se clickearon corren en paralelo entre sí.

**Takeaway:** al paralelizar cualquier flujo que use `pauseForHumanInteraction`
(o cualquier otro recurso global tipo stdin), separar primero qué parte
comparte ese recurso — no todo lo que "podría" correr en paralelo es seguro
de correr en paralelo.

## Descarga de MP3 rota en vivo (2026-07-03, "Veinte Años Después"): timeout reintroducido a 3 min + bypass de red que agota el watcher compartido + Create duplicado por re-correr sin --resume

Corrida real en vivo: las dos versiones fallaron la descarga automática.
Investigado después (sin tocar nada hasta confirmar con evidencia), con Chrome
y Node ya cerrados. Tres problemas independientes, todos con el mismo síntoma
visible ("no está sirviendo como antes"):

**1. `DOWNLOAD_WAIT_TIMEOUT_MS` bajado de 8 min a 3 min por una edición
externa** (no de esta sesión — el diff apareció solo, probablemente otra
herramienta/IDE tocando el repo en paralelo, ver el aviso de Antigravity en
memoria). Es literalmente el mismo bug ya documentado y arreglado más abajo en
este archivo ("Timeout de 90s esperando MP3 era demasiado corto para
generación real", 2026-07-01) — reintroducido con un valor distinto. Prueba
directa: el archivo real de la Versión A aterrizó en disco (confirmado con
`Get-Item .LastWriteTimeUtc`) más tarde de lo que el timeout de 3 min permitía,
así que el código lo dio por perdido antes de que terminara de escribirse.
**Fix:** restaurado a 8 min (el valor de diseño original, documentado en la
entrada de 2026-07-01).

**2. Un mecanismo nuevo de "Bypass de Red"** (intercepta `clip.audio_url` de
las respuestas `/api/` y lo inyecta como `<a download>` click) se había
agregado sin estar en ninguna sesión previa registrada acá. Dos problemas:
(a) es exactamente el patrón ya descartado el 2026-06-30 ("Flujo de descarga
de Suno no tiene botón directo" — un `<a download>` hacia una URL cross-origin
no garantiza que el navegador guarde el archivo si el servidor no manda
`Content-Disposition: attachment`); (b) más grave: comparte el mismo
`watcher`/timeout de `watchForNewMp3` con el flujo visual de fallback — si el
bypass se queda esperando hasta agotar el `deadlineMs`, el watcher ya está
`done`/cerrado cuando el código cae al flujo visual, así que aunque el click
visual funcione después, el watcher ya no está escuchando y jamás detecta el
archivo real. El fallback confiable nunca llegaba a tener una ventana de
verdad. **Fix:** eliminado por completo — el único mecanismo soportado vuelve
a ser el menú visual ⋯ → Download → MP3 Audio, con nota en el header del
archivo para que no se reintente sin releer esto.

**3. Cada vez que la descarga fallaba, correr `node start-flow.js` de nuevo
(sin `--resume`) volvía a llenar Suno y clickear Create desde cero sobre la
MISMA canción ya asignada** — confirmado con el contador real de créditos de
Suno cayendo ~110 entre dos corridas consecutivas sobre el mismo Song ID.
`run.js` siempre resetea `state.json` a stage `"generated"` al terminar
(`startNew()`), así que no había ninguna señal que un re-run pudiera leer para
darse cuenta de que ya había pasado por Suno-fill/Create antes. **Fix:**
`runFlow()` en `start-flow.js` ahora guarda un snapshot de `state.json` ANTES
de correr `run.js` (Paso 1); si después de que `run.js` termina el Song ID es
el mismo Y el snapshot de ANTES ya estaba en `suno-filled`/`flow-filled`, la
corrida se auto-degrada a comportamiento `--resume` desde esa etapa (nunca
re-clickea Create). No aplica si el snapshot decía `completed` — ese caso es
un REDO legítimo que sí necesita regenerar todo.

**Takeaway:** cuando algo que "andaba bien" deja de andar, revisar primero si
el código realmente cambió por fuera de esta sesión (`git diff`/timestamps)
antes de asumir que el bug es nuevo — acá fueron 2 regresiones reales
(timeout, bypass) más un gap de diseño viejo (sin protección contra Create
duplicado) que solo se hizo visible cuando las descargas empezaron a fallar
de verdad.

## Auditoría de mejoras 2026-07-03: nombre fonético falso-"ausente", sesión de horas exactas rota, 3 parsers duplicados sin sincronizar

Pase de mejoras sin gastar API ni tocar Suno/Flow en vivo (solo `npm test`).
Cuatro hallazgos concretos, cada uno cubierto con test nuevo:

**1. `missingNames` (verify-audio.js) marcaba "ausente" un nombre fonéticamente
reescrito.** El PENDIENTE ya documentado más abajo en este archivo (ver
entrada de memoria): el prompt reescribe el nombre para que Suno lo cante bien
("Jamie" → "Yeimi"), pero `analyzeAudio()` solo comparaba contra el nombre
crudo de la encuesta → falso "ausente" → auto-reroll quemado en vano (créditos
reales de Suno). Fix: `extractLyricNameVariants()` (`lib/text-helpers.js`) lee
la primera palabra de cada `[Chorus N]` de la letra ya generada. Para
single-recipient (el caso común) no hay ambigüedad — cualquier apertura de
Chorus ES el nombre de esa persona, así que se acepta sin exigir coincidencia
de letra (la respelling real puede cambiar hasta la primera letra: J→Y).
Para multi-destinatario, sin el flag `foneticaAplicada` disponible en
song.txt, se usa la misma heurística de letra que ya usa `hardValidate()`.
`analyzeAudio()` ahora acepta el nombre de encuesta O su variante de letra.

**2. Sesión de horas exactas ("1h session", sin minutos) nunca llegaba a
`parseSessionTime()`.** La función ya tenía una rama `hourOnly` (con comentario
explícito "sin esto, una sesión de exactamente 1 hora tiraría error") pero el
selector de DOM que la alimenta (`readRecentCompletion` en start-flow.js)
filtraba spans con `/\d+\s*(h\s*\d*\s*min|min)/i` — exige la palabra "min"
literal. Una card mostrando solo horas nunca matchea ese filtro, así que
`sessionText` quedaba `null` y el código tiraba `'No se encontró texto de
sesión'` ANTES de que `parseSessionTime` (o su rama hourOnly) llegara a
ejecutarse nunca. La rama existía pero era inalcanzable. Fix: el selector de
spans ahora también acepta `h(?:r|our)?s?\b` sin "min". De paso,
`parseSessionTime` se extrajo a `lib/session-time.js` porque start-flow.js no
es un módulo requireable (corre su pipeline entero al cargarse) — no se podía
testear donde vivía.

**3. Tres copias de `parseSongFile` divergentes.** Además de la duplicación ya
conocida entre suno-fill.js y flow-submit.js, `lib/sheets-core.js` tenía una
tercera versión (solo título + Song ID) que nunca se migró cuando se
extrajeron las otras dos. Mismo patrón de bug que "Enter Flow + Assign"
(2026-06-28, más abajo en este archivo): un fix aplicado a una copia no llega
a las otras. Unificadas las tres en `lib/song-file.js` (superset:
titulo/voz/estilo/lyrics/notes/songId). También se encontraron y unificaron:
`parseTituloFromSongFile` duplicado en `upload-to-flow.js`, y
`connectToSunoTab` duplicado en `lib/suno-create-dl.js` (con un `context` de
retorno que ni se usaba en el call site).

**4. `run.js`'s pre-check de "encuesta sin nombre de destinatario" tenía su
propio regex** (`What's their name`, apóstrofe recto only) en vez de reusar
`extractFirstNames()` de `lib/text-helpers.js` — que sí tolera apóstrofe curvo
y ya está testeado. Un survey con apóstrofe curvo (copy-paste desde Word/Google
Docs, pasa) disparaba un falso "⚠️ sin nombre" en cada corrida sin afectar la
generación real (esa sí usaba `extractFirstNames` en `hardValidate`) — el
warning simplemente mentía. Fix: `run.js` ahora reusa `extractFirstNames`
directamente, eliminando el regex duplicado.

**Takeaway:** ninguno de estos 4 se encontró corriendo el pipeline real — se
encontraron leyendo el código y confirmando con greps/inspección (ej. el punto
2 se confirmó viendo que el selector de línea 554 nunca produce "1h" sin
"min"). Cuando una rama de código tiene un comentario que explica por qué
existe pero nunca se ve activarse en la práctica, vale la pena rastrear hacia
atrás qué la alimenta — puede estar muerta por un filtro anterior, no por el
propio código.

## Suno le quitó el botón "Expand lyrics box" — screenshot de verificación quedaba stale en silencio (2026-07-02)

Hector corrió `node start-flow.js` en real y `suno-fill.js` reventó esperando
`[data-testid="lyrics-textarea"]` — ese selector ya no existe en el DOM de Suno
(rediseño de su UI). `lib/suno-selectors.js` ya tenía un fix sin commitear
(`LYRICS_TEXTAREA` con fallback a `[aria-label="Lyrics editor"]` y
`.lyrics-editor-content`) que resolvía eso, pero al validar en vivo apareció un
segundo bug, más peligroso porque fallaba callado: `EXPAND_LYRICS_BOX_LABEL`
("Expand lyrics box") tampoco existe más en la UI nueva. El bloque que generaba
`suno-verify-lyrics-expanded.png` estaba envuelto en
`if ((await expandBtn.count()) > 0)` — al no encontrarse, el bloque entero se
saltaba SIN error ni log, dejando el PNG de la corrida anterior tirado ahí como
si fuera de la canción actual. Confirmado con timestamps: `suno-verify-
overview.png` con la hora de la corrida real, `suno-verify-lyrics-expanded.png`
con la hora de una canción de horas antes (letra de otra persona, "Teresa" en
vez de "Marlene") — exactamente el escenario que la regla de "verificación
visual antes de Create no es opcional" existe para atrapar, roto por dentro.

**Causa raíz:** confiar en un `aria-label` de texto libre de un producto de
terceros como selector — Suno puede renombrar/quitar el botón en cualquier
rediseño sin avisar, y el código lo trataba como "no aplica esta vez" en vez de
"algo cambió, avisar".

**Fix (`suno-fill.js`):** si `EXPAND_LYRICS_BOX_LABEL` no se encuentra, loguea
una advertencia explícita, borra el `.expanded.png` viejo si existe (nunca dejar
un archivo con pinta de fresco que no lo es), y genera
`suno-verify-lyrics-top.png` en su lugar: `lyricsBox.scrollIntoViewIfNeeded()`
(el PANEL contenedor tiene su propio scroll, separado del de adentro de la
letra — sin este paso el screenshot mostraba el cuadro de Estilo en vez del de
Letra) + `el.scrollTop = 0` (para ver Verse 1, no el final donde queda el
cursor después de tipear 1381 caracteres).

**Takeaway:** cualquier selector basado en texto/aria-label de una UI de
terceros que hoy cae a un `if (count > 0) { ... } ` sin `else` es un candidato a
fallo silencioso — cuando el elemento desaparece, el bloque no corre y nadie se
entera. Si el paso importa para la seguridad del pipeline (como la verificación
visual), el `else` tiene que loguear fuerte y dejar rastro de que el fallback
se activó, no solo saltear.

## Sonnet 5 truncaba song.txt con el mismo max_tokens que andaba bien en Sonnet 4.6 (2026-07-02)

Al migrar `run.js` de `claude-sonnet-4-6` a `claude-sonnet-5` (mismo llamado, mismo
`cache_control: { type: "ephemeral" }`), `max_tokens: 4000` — que ya se había subido
una vez antes desde 1500 por el mismo síntoma (ver la entrada de 2026-06-29 "song.txt
truncado" más abajo) — volvió a quedarse corto. Confirmado con 2 llamadas de prueba
reales (mismo `SYSTEM_PROMPT` real extraído de `run.js`, misma encuesta de muestra):
ambas volvieron con `stop_reason: "max_tokens"`, es decir, la letra se cortaba a mitad
de generación en vez de terminar sola.

**Causa:** Sonnet 5 usa un tokenizer distinto al de Sonnet 4.6 (el mismo que Opus
4.7/4.8) que produce ~30% más tokens para el mismo contenido/razonamiento. Un
presupuesto de salida que alcanzaba de sobra en 4.6 pasa a quedar justo — o corto —
en 5, sin que cambie nada del contenido que se le pide generar.

**Fix:** `max_tokens` subido de 4000 a 7000 en la llamada de `generateSongWithClaude`.
Re-verificado con las mismas 2 llamadas de prueba: ambas terminaron con
`stop_reason: "end_turn"` (output real de 4189 y 5195 tokens, bajo el nuevo techo de
7000), con `**Título:**` y `[Outro]` presentes en la respuesta — estructura completa,
sin cortes.

**Takeaway:** cualquier migración de modelo que cambie de familia de tokenizer
(Sonnet 4.6/Fable-anterior → Opus 4.7+/Sonnet 5) necesita revisar `max_tokens` como
parte de la migración, no asumir que el valor viejo sigue siendo válido — aunque el
prompt y la lógica no cambien en absoluto. Verificar con `stop_reason`, no solo con
que la llamada no tire error (una respuesta cortada a mitad de la letra devuelve
HTTP 200 igual).

**De paso, cache de prompt subido de 5 minutos a 1 hora.** Con la migración a
Sonnet 5 se aprovechó para revisar si convenía pasar el `cache_control` de
`{ type: "ephemeral" }` (TTL de 5 min) a `{ type: "ephemeral", ttl: "1h" }`. El
`run.js` no usa el SDK de Anthropic (hace `fetch()` crudo), así que se verificó
directo contra la API: **la variante `ttl: "1h"` no pide ningún beta header** — es
GA, se probó con y sin `anthropic-beta: extended-cache-ttl-2025-04-11` y ambas
funcionaron igual. Confirmado con una escritura fresca que el uso viene etiquetado
`cache_creation.ephemeral_1h_input_tokens` (no como `ephemeral_5m`), y con una
prueba real de más de 5 minutos de pausa (324s) que el cache seguía sirviendo
`cache_read_input_tokens` en vez de recrearse — algo que con el TTL viejo de 5 min
ya habría expirado.

Matemática de conveniencia (con el system prompt real de ~5922 tokens): 1h sale
más barato en cuanto evita más de ~60% de los "cache miss" que el TTL de 5 min
hubiera sufrido (la escritura de 1h cuesta 2× vs 1.25× de la de 5 min, pero ambas
leen igual de barato a 0.1×). Dado que `run.js` corre en un poller de cola con
pausas irregulares entre canciones (llegada de pedidos, no un cron fijo), es
esperable que la mayoría de los huecos entre llamadas caigan en el rango
"5-60 minutos" — exactamente lo que el TTL de 1h convierte de escritura cara a
lectura barata — y que solo 1-3 veces por día el hueco real supere la hora
(arranque del día, algún corte largo). Bajo ese patrón típico, 1h TTL gana.
Cambio de una sola palabra (`ttl: "1h"` en el `cache_control` de `generateSongWithClaude`),
no toca lógica de negocio.

**Auditoría de grasa en el system prompt (medida, no aplicada):** con
`count_tokens` real se identificaron ~1000-1050 tokens (~17-18% de los 5922
totales) potencialmente recortables sin tocar las reglas de QA ni la validación
estructural: (1) el checklist de QA está duplicado — una vez en inglés como
instrucción interna ("AUTO-QA CHECKLIST", 717 tokens, con el mandato "verificá y
regenerá hasta 3 veces") y otra vez en español como parte del formato de salida
obligatorio que se pega en `song.txt` (481 tokens) — son ~1200 tokens de contenido
semánticamente igual en dos idiomas; (2) las 8 plantillas de estilo Suno (Balada,
Norteño, Salsa, Bachata, Reggaetón, Worship, Mariachi, Pop cristiano — 1067 tokens)
repiten el sufijo obligatorio de 6 palabras 8 veces y comparten vocabulario. No se
tocó nada de esto — comprimir el checklist es de bajo riesgo (es duplicación real,
pero hay que preservar en algún lado el mandato "regenerá si falla, máx 3
intentos" que hoy solo vive en el bloque en inglés); comprimir las plantillas de
estilo es de mayor riesgo porque esas frases exactas probablemente fueron
afinadas a mano para que Suno interprete bien el género — ameritan pruebas de
audio antes de tocarlas, no solo revisión de texto.

## Checklist de QA duplicado (inglés + español) comprimido en el system prompt — PENDIENTE DE VALIDAR CON PRUEBA REAL (2026-07-02)

Siguiendo la auditoría de arriba, se comprimió el bloque "AUTO-QA CHECKLIST"
en inglés (259-284 de `run.js`, 21 ítems + el mandato de regeneración) para que
en vez de repetir los 20 ítems ya presentes en el `**QA Checklist:**` en
español (el que se pega literal en `song.txt` y que `hardValidate()` parsea
línea por línea buscando `✓`/`✗`/`(si aplica)` — ver sección K de
`hardValidate` en `run.js`), apunte a ese mismo bloque como fuente de verdad:
"verificá internamente, ítem por ítem, cada línea del **QA Checklist** definido
en RESPONSE FORMAT" en vez de repetir la lista completa en inglés.

**Se preservó explícitamente, palabra por palabra:** "If any item fails,
regenerate. Maximum 3 attempts. If still failing after 3 attempts, deliver
with: ⚠️ REVISAR MANUALMENTE: [list of failed items]" — el mandato de
regeneración no se tocó.

**No se tocó:** el bloque `**QA Checklist:**` en español (RESPONSE FORMAT,
sigue con los mismos 20 ítems, mismo formato `✓/✗`, mismo `(si aplica)` para
destinatarios múltiples — exactamente lo que `hardValidate()` espera parsear),
ninguna de las reglas de contenido (RULES BY SECTION, GENERAL RULES 1-18,
MULTIPLE RECIPIENTS, PHONETIC RE-SPELLING), las 8 plantillas de estilo Suno,
`max_tokens`, ni el bloque `cache_control`.

**Tokens: 5922 → 5367 (−555 tokens, ~9.4%)**, medido con `count_tokens` real
contra `claude-sonnet-5` (no se corrió ninguna generación real ni llamada de
prueba — solo medición de tokens, a pedido explícito).

**⚠️ PENDIENTE DE VALIDAR CON PRUEBA REAL** — falta correr al menos una
generación completa (encuesta real o de prueba) y confirmar que: (a) Claude
sigue produciendo el bloque `**QA Checklist:**` completo y en el formato
esperado por `hardValidate()`, (b) el comportamiento de auto-verificación +
regeneración ante fallos sigue funcionando igual que antes de comprimir, (c)
no bajó la calidad de la letra por tener el checklist de verificación interna
menos explícito en inglés. No usar en producción hasta validar.

## `start-flow.js` no disparaba `verify-audio.js` automáticamente — quedaba 100% manual (2026-07-01)

El pipeline solo imprimía "Corré: node verify-audio.js" como instrucción para
Gabo después de que los MP3 aterrizaban — nada lo lanzaba. Se pidió agregar
un disparo automático que no bloquee el resto del pipeline (Paso 4/4 sigue
inmediatamente) y que nunca rompa `start-flow.js` si `verify-audio.js` falla.

**Fix:** nueva `launchAutoVerify({ fast })` en `start-flow.js`, llamada justo
después de que `createAndDownload()` confirma los 2 MP3 (dentro del mismo
`try` que ya mandaba la notificación "MP3s listos"):
1. `spawn('node', ['verify-audio.js', ...args], { detached: true, stdio: [...] })`
   + `child.unref()` — proceso hijo desacoplado. `start-flow.js` sigue de
   inmediato con el Paso 4/4, no espera (confirmado: `launchAutoVerify`
   retorna en ~13ms en la prueba, el análisis real sigue corriendo aparte).
2. stdout/stderr del hijo van a un archivo en `logs/verify-audio-auto-<timestamp>.log`
   (no a la terminal — el proceso padre puede terminar antes de que el hijo
   termine, así que hace falta un log persistente para revisar después).
3. `child.on('error', ...)` y `child.on('exit', code !== 0)` mandan un aviso
   por ntfy si el spawn falla o si `verify-audio.js` termina con error —
   nunca lanzan ni relanzan una excepción hacia `runFlow()`.
4. Flags: `--no-auto-verify` saltea este paso por completo (vuelve al flujo
   100% manual). `--fast-verify` fuerza el modo rápido (Whisper small/CPU,
   sin argumentos extra) en vez de `--demucs`, que es el default — decisión
   explícita de Hector: como corre en background, el tiempo extra de
   `--demucs` (demucs + Whisper large-v3 CUDA) no bloquea nada.

**Gotcha de diseño (documentado, no arreglado — no hace falta):** si
`start-flow.js` termina y el proceso Node del padre muere ANTES de que el
hijo desacoplado termine, el listener `child.on('exit', ...)` de ESE padre
nunca dispara (proceso ya no existe) — el aviso por ntfy de fallo se pierde,
aunque el proceso hijo (que sigue vivo, detached) sí completa y el log queda
igual. En la práctica esto no pasa: después del Paso 3c, `runFlow()` sigue
con el Paso 4/4 y después `askDoneQuestion()` (espera input interactivo de
Gabo, que tarda minutos) — tiempo de sobra para que el análisis (incluso en
`--demucs`, ~1-4 min) termine y dispare su propio listener antes de que el
padre se cierre. Si algún día `start-flow.js` termina mucho más rápido que
hoy, revisar el log en `logs/` sigue siendo el fallback confiable.

**Verificado con un test aislado (no con el pipeline real):** confirmado que
`launchAutoVerify` retorna sin bloquear, que el log captura toda la salida de
un `verify-audio.js` de prueba corriendo hasta el final, y que un
`verify-audio.js` que falla (título sin MP3 → `process.exit(1)`) no
interrumpe ni lanza una excepción en el proceso que lo lanzó.

## Medición de tiempos en `verify-audio.js` (demucs / Whisper / total) (2026-07-01)

Antes de decidir si el auto-verify (ver arriba) debía usar `--demucs` siempre,
hacía falta ver tiempos reales en la RTX 4070. Se agregó tracking de tiempos
en `lib/audio-analysis.js`:

- `report.timing = { demucsMs, whisperMs, totalMs }` por versión, calculado
  con `Date.now()` alrededor del bloque de `runDemucsSeparate` (dentro del
  `finally` interno, así se registra el tiempo del intento aunque falle) y
  alrededor del `spawnSync` de `transcribe.py` (capturado tanto en el path de
  éxito como en el `catch`, para que un fallo de Whisper igual muestre cuánto
  tardó en fallar).
- `printReport` imprime una línea `⏱️ Tiempo: demucs Xs + whisper Ys → total Zs`
  por versión, más un total combinado (A + B) al final del reporte.
- `verify-audio.js` mide el tiempo total del script completo (desde el primer
  `Date.now()` hasta después de `printReport`) y lo muestra en consola y en el
  mensaje de ntfy (`"Análisis listo (Xm Ys): ..."`).
- Nuevo helper `formatElapsed(ms)` en `lib/audio-analysis.js`, exportado para
  reuso en `verify-audio.js`.

**Verificado con un MP3 sintético de prueba:** el reporte mostró
`whisper 7s → total 7s` por versión y `verify-audio.js completo en 8s` al pie
— la estructura del breakeven funciona; los tiempos reales con `--demucs` en
canciones de 3 minutos van a ser mayores (demucs + Whisper large-v3 sobre
audio real, no un tono sintético de 6s), hace falta correrlo con una canción
real para tener el número que motivó este pedido.

**Takeaway:** cualquier decisión de "qué modo usar por default" basada en
tiempo necesita instrumentación real, no una estimación — por eso se pidió
esto antes de fijar `--demucs` como default del auto-verify.

## Panel de Lyrics/Inspo expandido tapa Create — distinto del mini-player (2026-07-01)

`safeClick` venía reportando el bloqueador `div.card-popout-boundary` con texto
"AudioVoiceNewInspoLyrics[Verse 1]..." al clickear Create. Parecía el mismo
bug del mini-player (misma familia: overlay flotante con z-index alto tapando
Create) pero es un elemento distinto — el panel expandido de Lyrics/Inspo de
Suno, no el reproductor. `dismissMiniPlayerIfPresent` no lo detecta porque sus
selectores son específicos del player (`aria-label="Close player"` etc.), así
que `lib/suno-create-dl.js` reintentaba `safeClick` 5 veces sin cerrar nunca
el panel real, fallando siempre igual.

**Pista clave para el fix:** `suno-fill.js` ya abre y cierra este mismo panel
en cada corrida (toggle `page.getByLabel('Expand lyrics box')`, usado para el
screenshot de verificación y luego re-clickeado para colapsarlo antes de
terminar). Ese selector ya está probado en producción — no hizo falta abrir
una sesión de Suno en vivo para descubrirlo, ya estaba demostrado funcionando
en un script hermano del mismo repo.

**Fix:** nueva `dismissLyricsPopoutIfPresent(page)` en `lib/suno-create-dl.js`,
en el orden pedido:
1. Click en área neutral (esquina superior izquierda) — puede cerrar el panel
   solo, como un dropdown estándar.
2. El toggle `Expand lyrics box` (mecanismo primario, ya probado en
   `suno-fill.js`) y, si no aparece, una lista de selectores genéricos de
   cerrar/collapse dentro del propio `div.card-popout-boundary`.
3. `Escape` como último intento antes de que el caller recurra a
   `jsClickCreate` (bypass total de z-index, ya existente).

Nueva `ensureCreateClickable(page, createBtn, label)` envuelve esto: cierra
mini-player + panel de Lyrics, espera 500ms, y verifica con
`isClickable()` (nuevo helper en `lib/playwright-helpers.js`, usa
`elementFromPoint` igual que `identifyBlocker` pero devuelve boolean) que
Create no está tapado — si sigue tapado, reintenta el cierre una vez más y
loguea una advertencia explícita en vez de seguir en silencio. Se llama antes
de AMBOS clicks de Create (el panel puede reabrirse entre el primer y el
segundo click).

**Nota de honestidad:** este fix se implementó sin abrir una sesión real de
Suno para probarlo en vivo — no había ninguna corriendo al momento del fix, y
levantar una nueva session solo para el test tocaría la cuenta real de Gabo.
Se armó con evidencia concreta del propio repo (el toggle ya demostrado en
`suno-fill.js`) en vez de selectores inventados a ciegas. Si en la próxima
corrida real el bloqueador persiste, revisar el log `[lyrics-popout]` — dirá
exactamente cuál de los 3 mecanismos (o ninguno) cerró el panel.

## Timeout de 90s esperando MP3 era demasiado corto para generación real (2026-07-01)

`downloadVia3DotMenu` llamaba `watchForNewMp3(watchDirs, destPath, 90000)`
con el timeout hardcodeado en el call site (no el default de la función, que
tampoco importaba porque el call site lo pisaba). Suno tarda 2-4 minutos en
generar la canción completa MÁS el tiempo de que la descarga aterrice en el
filesystem — 90 segundos no alcanzaba ni para la generación sola, y el script
tiraba `Timeout 90000ms esperando MP3 en Downloads/suno/` en corridas
completamente normales.

**Fix:**
1. Nueva constante `DOWNLOAD_WAIT_TIMEOUT_MS = 8 * 60 * 1000` (mismo valor que
   `GENERATION_TIMEOUT_MS`, que ya era 8 min — era el valor de diseño
   original). El call site en `downloadVia3DotMenu` ahora la usa en vez del
   `90000` hardcodeado.
2. Verificado que `watchForNewMp3` sigue vigilando `sunoDir` Y
   `Downloads` general en paralelo (ambos entran a `watchDirs`, cada uno con
   su propio `fs.watch` + el poll timer compartido de 3s sobre todos) — no se
   había perdido en ningún refactor.
3. Verificado que el watcher arranca ANTES de disparar la descarga: en
   `downloadVia3DotMenu`, `watchForNewMp3(...)` se crea al principio de la
   función, antes de clickear ⋯ → Download → MP3 Audio — ya estaba bien, no
   hizo falta reordenar nada.
4. Nuevo log de progreso cada 30s (`PROGRESS_LOG_INTERVAL_MS`) dentro de
   `watchForNewMp3`: `"⏳ Esperando MP3... Xmin Xs transcurridos"`, para que
   quede claro que el script sigue vivo durante la espera larga.

**Takeaway:** cualquier timeout que dependa de un proceso externo lento
(generación de IA, uploads, etc.) necesita margen real, no un valor
"razonable" a ojo — y si el margen es largo (minutos), sumar logs de
progreso para que no parezca colgado.


## `verify-audio.js` — pipeline avanzado con `--demucs` (CUDA RTX 4070) (2026-06-30)

Se agregó un modo opcional (`node verify-audio.js --demucs`) que separa la voz
con demucs y transcribe con Whisper large-v3 en CUDA. **Sin el flag, el
comportamiento es exactamente el de siempre** (Whisper small en CPU) — el
flag es la única puerta de entrada a todo lo pesado.

**Instalación (una sola vez, en este orden):**
```
npm install fastest-levenshtein
pip install faster-whisper
pip install torch --index-url https://download.pytorch.org/whl/cu124
pip install torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124
pip install soundfile
pip install demucs
```

**Gotcha #1 — torchaudio de PyPI rompe el backend de audio en Windows.**
`pip install demucs` trae `torchaudio` como dependencia, pero si se instala
desde PyPI (index por defecto) baja una build CPU-only cuyo extension nativo
NO matchea el torch+cu124 ya instalado → `OSError: [WinError 127] The
specified procedure could not be found` al importar. Fix: reinstalar
`torchaudio==2.6.0` explícitamente desde el índice de PyTorch
(`--index-url https://download.pytorch.org/whl/cu124 --force-reinstall --no-deps`)
DESPUÉS de instalar demucs, no antes (demucs lo pisa si va antes).

**Gotcha #2 — torchaudio 2.6 sin backend de guardado.** Sin el paquete
`soundfile` instalado, `torchaudio.save()` tira `RuntimeError: Couldn't find
appropriate backend to handle uri ... .wav`. demucs necesita `soundfile` para
poder escribir `vocals.wav`/`no_vocals.wav` en Windows.

**Verificación de que el CUDA real funciona (no asumir):**
```
python -c "import torch; print(torch.cuda.is_available())"   # debe dar True
demucs -n htdemucs_ft --two-stems vocals -o out cancion.mp3    # demucs detecta cuda solo
```
demucs elige `cuda` automáticamente si está disponible (no hace falta pasarle
`-d cuda`); `lib/transcribe.py` sí necesita el flag explícito `--device cuda`
porque decide qué compute_type usar (`float16` vs `int8`).

**Diseño del fallback CUDA→CPU:** vive enteramente en `lib/transcribe.py`
(`load_model()`): intenta `device="cuda", compute_type="float16"`, y si
`WhisperModel(...)` tira excepción (CUDA no disponible, VRAM insuficiente,
etc.) reintenta con `device="cpu", compute_type="int8"` y loguea el warning a
stderr — nunca a stdout, para no ensuciar el JSON que lee Node.

**Diseño de "sin demucs instalado":** `lib/audio-analysis.js` intenta
`spawnSync('demucs', ...)`; si el error es `ENOENT` (comando no encontrado)
o el proceso falla, loguea warning y sigue transcribiendo el MP3 completo con
el mismo modelo/CUDA (no vuelve a Whisper small) — el usuario pidió `--demucs`,
así que la mejora de transcripción se mantiene aunque la separación de voz no.

**Cleanup:** cada corrida con `--demucs` crea su propia carpeta temporal
(`os.tmpdir()/cancioneterna-demucs-<timestamp>-<random>`) y se borra en un
`finally` sin importar si la transcripción falló — nunca queda basura en disco.

## `lib/suno-create-dl.js` identificaba cards por posición/`<audio>` global — descargaba la canción vieja (2026-06-30)

Root cause único detrás de 4 síntomas (Create parecía no clickearse, descargaba
la canción equivocada, no esperaba la generación real, nombraba mal el archivo):
el código contaba `<audio>` GLOBALMENTE en el DOM y usaba `cardIndex` fijo (0,1)
para el botón ⋯. Pero Suno deja las canciones viejas en la lista con su audio ya
cargado (aunque `<audio>` NO está en el DOM hasta que tocás play — confirmado
inspeccionando el DOM en vivo: `hasAudio: 0` en TODAS las cards, viejas y
nuevas). Con canciones viejas ya "completas" en la lista, el conteo daba
falsos positivos de "generación terminada" antes de que Create siquiera hubiera
arrancado, y las "primeras N cards" por índice eran las viejas, no la nueva.

**Fix:** cada card (`[data-testid="clip-row"]`) tiene un link `<a class="hover:underline">`
con `href="/song/<uuid>"` — un ID único y estable que no cambia aunque la lista
se reordene. Ancla nueva:
1. Antes de Create, snapshot de todos los hrefs existentes (`existingHrefs`).
2. Tras cada click en Create, confirmar que apareció al menos 1 href NUEVO
   (`waitForCreateStarted`) antes de asumir que la generación arrancó — si no
   aparece ninguno en 15s ni con click ni con JS click, tirar error claro en
   vez de seguir a ciegas.
3. "Lista para descargar" (`ready`) = la card tiene una duración tipo "3:22"
   renderizada (`/^\d+:\d{2}$/` en un div hoja) y no tiene spinner/progressbar
   — NUNCA por conteo de `<audio>`.
4. `waitForGeneration` sólo mira cards cuyo href está en el set de "nuevas" Y
   cuyo título normalizado coincide con el título verificado antes de Create.
   Si una card nueva queda lista con un título distinto al esperado, frena con
   error — nunca descarga a ciegas (cubre el caso REDO con el mismo título:
   las cards viejas comparten título pero tienen otro href, así que nunca
   entran al set de "nuevas").
5. La descarga (`downloadVia3DotMenu`) localiza la card por href
   (`page.locator('[data-testid="clip-row"]').filter({ has: locator('a[href="..."]') })`)
   y busca el botón `[aria-label="More options"]` DENTRO de esa card específica,
   nunca por índice global entre todos los botones ⋯ de la página.

**Takeaway:** en Suno, nunca identificar una card por posición ni contar
elementos globalmente en el DOM — buscar un identificador único y estable
(el `href` del link del título) y anclar toda la lógica (arranque, espera,
descarga, nombre de archivo) a ese ID + al título verificado.

## Mini-player de Suno tapa el botón Create con z-index (2026-06-30)

Suno muestra un mini-player fijo en la parte inferior de la pantalla cuando
hay una canción reproduciéndose. Ese elemento tiene z-index mayor que el botón
Create, por lo que Playwright reporta `"element is not visible"` o `"subtree
intercepts pointer events"` — el botón existe en el DOM pero está físicamente
tapado por el player.

**Fix:** antes de cada Create, llamar `dismissMiniPlayerIfPresent(page)` que
prueba selectores conocidos de close-button del player y, si no los encuentra,
hace `Escape`. Si `safeClick` igualmente falla después (z-index persistente),
cae a `jsClickCreate(page)` = `element.click()` via `page.evaluate()`, que
bypasea completamente los checks de pointer-events de Playwright.

**Takeaway:** en Suno, nunca clickear directamente sin primero descartar el
mini-player. El JS click directo es el último recurso válido cuando Playwright
no puede sintetizar el pointer event por z-index.

## Flujo de descarga de Suno no tiene botón directo — es ⋯ → Download → MP3 Audio (2026-06-30)

La implementación anterior intentaba descargar via `fetch()` con la URL del CDN
de los elementos `<audio>` del DOM. Esto falla porque:
1. La URL CDN puede requerir auth que fetch no propaga correctamente.
2. Suno no tiene botón de descarga directo — el flujo real es el menú contextual.

El flujo real en la UI es:
  Botón ⋯ (More options) en la card de la canción
  → opción "Download" en el menú
  → opción "MP3 Audio" en el submenú (NUNCA WAV, NUNCA Pro)

**Fix:** `downloadVia3DotMenu(page, cardIndex, sunoDir, destPath)` en
`lib/suno-create-dl.js` implementa este flujo con `safeClick` en cada paso y
menú-texto para identificar las opciones (no class-names dinámicas).

**Takeaway:** cuando el DOM tiene un elemento de audio con src CDN, eso NO
significa que puedas descargarlo con fetch. Siempre usar el flujo de UI real
de la aplicación para descargas.

## Downloads de Suno van a Downloads general, no a sunoDir (2026-06-30)

`Browser.setDownloadBehavior` vía CDP (intentado con `browser.newBrowserCDPSession()`)
no siempre redirige correctamente en Chrome conectado via `connectOverCDP` — el
comando se aplica a la sesión CDP, no al perfil completo, así que Chrome sigue
usando su propia configuración de descarga.

**Fix:** `watchForNewMp3(watchDirs, destPath, timeoutMs)` en `suno-create-dl.js`
usa `fs.watch` + polling cada 3s sobre AMBAS carpetas (`sunoDir` Y `Downloads`
general) en paralelo. En cuanto aparece un .mp3 nuevo (>50KB = completo) en
cualquiera de ellas, lo mueve a `destPath` vía rename/copy. CDP redirect se
mantiene como best-effort (si funciona, mejor; si no, el watcher lo maneja).

**Takeaway:** para automatizar descargas en Chrome externo via CDP, siempre
agregar un watcher de filesystem como fallback. No confiar en que CDP redirige
correctamente.

## "subtree intercepts pointer events" en click de Create de Suno (2026-06-30)

`page.click()` o `locator.click()` sobre el botón Create de Suno fallaba con
`"Error: subtree intercepts pointer events"` — un elemento hijo o superpuesto
capturaba el evento de puntero en lugar del botón. El overlay era transitorio
(posiblemente un tooltip, un spinner de estado, o un banner de "generando").

**Fix:** se creó `safeClick(page, locator, opts)` en `lib/playwright-helpers.js`.
El helper:
1. Hace scroll del botón al viewport.
2. Intenta `click({ trial: true })` — si no lanza, el botón está libre y se clickea.
3. Si trial lanza, usa `document.elementFromPoint(cx, cy)` en el centro del botón
   para identificar exactamente qué elemento está encima (tag, id, class, texto).
4. Loguea el bloqueador con coordenadas para diagnóstico.
5. Espera `waitMs * attempt` ms y reintenta (hasta `maxAttempts`, default 5).
6. En el último intento usa `force: true` como último recurso.
7. Si sigue fallando, lanza con el nombre exacto del bloqueador en el mensaje.
8. Si `screenshotPrefix` se pasa, guarda screenshots antes de cada intento
   para diagnóstico visual.

Se aplicó a: Create × 2 en `lib/suno-create-dl.js`, `expandIfCollapsed` en
`lib/playwright-helpers.js`, y `genderButton` en `suno-fill.js`.

**Takeaway:** nunca clickear directamente en Suno con `.click()` desnudo — usar
`safeClick`. Si el error persiste en algún botón nuevo, agregar el selector del
bloqueador identificado acá para que `safeClick` lo reconozca y espere.

## `networkidle` siempre da TimeoutError en Suno y el Flow (2026-06-30)

`waitUntil: 'networkidle'` y `waitForLoadState('networkidle')` fallaban
consistentemente en `start-flow.js` (y en cualquier script que toque Suno o
cancioneterna.com): la red nunca queda idle porque Suno tiene websockets +
polling de queue activos permanentemente, y el Flow tiene sus propias
conexiones persistentes. Playwright agotaba los 30s y tiraba `TimeoutError`
en cada reload/goto.

**Fix:** eliminados TODOS los usos de `networkidle` del repo (`grep -rn networkidle`).
Reemplazados por:
- `waitUntil: 'domcontentloaded'` con `timeout: 60000` en todo `reload` y `goto`.
- Espera de selector concreto del DOM (`waitForSelector`, `waitForFunction`)
  como señal real de que la página cargó, en vez del estado de la red.

**Takeaway:** `networkidle` está deprecado por Playwright por este motivo exacto —
es inviable en cualquier SPA con conexiones persistentes. El reemplazo correcto
es siempre un selector estructural estable (`data-testid`, `id`, texto de botón)
que solo aparece cuando el estado de la página es el esperado. Nunca usar estado
de red como proxy de "página lista".

## `enterFlowAndEnsureAssignment` fallaba si React no había renderizado aún (2026-06-30)

La función verificaba `#lyrics`, `Enter Flow` y `Assign Most Urgent Song` con
`.count()` inmediato — si React todavía no había pintado ninguno de los tres
(lo cual es normal, el contenido llega async después de `domcontentloaded`),
los tres conteos devolvían 0 y el código caía directo al error genérico
"No se encontró #lyrics, ni Enter Flow, ni Assign Most Urgent Song" sin haber
esperado nada.

**Fix:** la función ahora hace `page.waitForFunction()` con timeout 30s que
hace un race entre los cuatro estados posibles del DOM: `'lyrics'` (#lyrics
presente), `'enter-flow'` (botón Enter Flow visible), `'assign'` (botón Assign
visible), o `'login'` (formulario de email/password visible). Solo cuando uno
de ellos aparece, actúa. Si ninguno aparece en 30s, tira error descriptivo con
la URL actual. Si detecta login (por URL o por formulario), da un error claro
"Sesión no logueada en el Flow" en vez del timeout genérico.

**Takeaway:** nunca usar `.count()` inmediato para detectar el estado de una
SPA después de una navegación. React renderiza async: el DOM puede estar vacío
un instante después de `domcontentloaded`. El patrón correcto es `waitForFunction`
o `waitForSelector` con timeout real, que esperan a que el contenido aparezca.

## Paso 2/4: falso "no hay sesión" por página de Suno cargando lento (2026-06-30)

`checkSunoLoginOnce()` llama a `isLoggedIn()`, que detecta login buscando el botón
"Create" con `getByRole('button', { name: /create/i })`. Si la página está en estado
intermedio — pantalla negra, skeleton loading, o i18n keys sin resolver (ej.
`"createForm.createButton"` en vez de `"Create"`) — ese selector devuelve 0 aunque
el usuario sí esté logueado. La función devuelve `false` inmediatamente, disparando
un wait manual de 5 minutos que no era necesario.

**Fix:** nueva función `checkSunoSessionReady(maxAttempts=3)` en `start-flow.js`:
1. Navega a `suno.com/create` si no está ahí.
2. Espera hasta 10 s a que aparezca un indicador definitivo: ya sea
   `[data-testid="lyrics-textarea"]` (formulario presente = logueado) o un
   elemento con texto exacto "Sign in" (no logueado). El `data-testid` no depende
   de traducciones, así que es estable aunque los labels muestren claves i18n crudas.
3. Si ninguno aparece en 10 s → la página no cargó bien → `page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })`
   + 3 s de espera → reintento.
4. Máximo 3 intentos. Si se agotan sin estado definitivo, devuelve `false` y entra
   en el wait de login manual (comportamiento anterior), logueando el motivo.
5. `runFlow()` ahora llama `checkSunoSessionReady()` en vez de `checkSunoLoginOnce()`.

`checkSunoLoginOnce()` y `waitUntilSunoLoggedIn()` siguen iguales — se usan en el
bucle de poll durante el wait manual, donde la página ya está en un estado conocido.

**Takeaway:** para detectar estado de sesión no hay que buscar texto UI traducible
— hay que esperar un elemento estructural estable (`data-testid`, `id`, selector
de atributo) que aparezca solo cuando la página está realmente cargada. Usar texto
visible como proxy del estado de carga es frágil ante i18n keys y skeleton screens.

## Suno no carga traducciones: selectores de texto fallan con i18n keys crudas (2026-06-30)

A veces la página de Suno carga pero no resuelve las traducciones de la UI —
los textos aparecen como claves crudas del sistema de i18n
(ej: `"createForm.advancedOptionsCardMoreOptions"` en vez de `"More Options"`).
Cualquier selector basado en texto (`getByText`, `getByRole`, `getByLabel`)
falla con timeout porque el texto esperado no existe en el DOM.
Lo que disparó el bug: `expandIfCollapsed` esperando `getByText('More Options')`
colgó 30 segundos y tiró error, interrumpiendo el flujo.

**Fix:**
1. `expandIfCollapsed` ahora hace `toggle.waitFor({ state: 'visible', timeout: 10000 })`
   antes de hacer click — falla rápido (10 s) en vez de colgar 30 s, lo que permite
   que el mecanismo de retry externo reaccione a tiempo.
2. Todo el llenado del formulario en `suno-fill.js` fue extraído a `fillSunoForm()`.
3. `fillSunoForm` se llama dentro de `withReloadRetry(page, fn, { maxAttempts: 3 })`,
   un nuevo helper en `lib/playwright-helpers.js`. Si cualquier selector dentro de
   `fillSunoForm` falla (More Options, Advanced tab, Write radio, género, sliders,
   title input), `withReloadRetry` hace `page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })`
   + 3 segundos de espera, y reintenta el llenado completo desde cero.
4. Máximo 3 intentos totales. En el último, tira error descriptivo que apunta a un
   problema temporal de Suno, no del script.
5. Los logs muestran: `"[suno-fill] Selector no encontrado, recargando página (intento N/3)..."`.

**Por qué reload completo (no retry del selector aislado):** si las traducciones
no cargaron, es toda la página la que está en mal estado. Recargar resetea el
formulario, así que el retry tiene que re-llenar todo. Envolver `fillSunoForm`
entera es más limpio que re-llenar campos individualmente en cada retry.

**Takeaway:** cualquier selector de texto de la UI de Suno (tab names, button
labels, placeholders) puede aparecer como clave i18n sin traducir si la página
cargó mal. El fix no es hacer los selectores más tolerantes — es detectar el fallo
rápido y recargar. `withReloadRetry` en `lib/playwright-helpers.js` queda disponible
para cualquier otra función del pipeline que necesite el mismo patrón.

Running log of real bugs hit while building this automation, so they don't get
rediscovered from scratch. Newest first.

## song.txt truncado: max_tokens insuficiente en REDO complejo (2026-06-29, "Mi Mayor Orgullo")

En un REDO con 5 destinatarios + Spoken Intro, la respuesta de Claude se truncó
antes de llegar a `**Título:**` porque `max_tokens: 1500` no alcanzó para el
razonamiento visible + salida estructurada completa. `hardValidate()` detectó la
ausencia de `**Título:**` (check L) pero el mecanismo de guardado usaba `fullResponse`
como fallback cuando `tituloIndex === -1`, así que el chain-of-thought crudo terminó
en `song.txt` en vez de la letra real.

**Fix:**
1. `max_tokens` subido de 1500 a 4000 en `generateSongWithClaude()` — aplica a
   todos los casos, no solo REDOs.
2. Nueva función `validateContentForWrite(lyricsContent)` en `run.js`: antes de
   escribir `song.txt`, verifica que `**Título:**` exista y no esté vacío y que las
   6 secciones ([Verse 1]…[Outro]) tengan contenido real.
3. Si esa validación falla después de agotar los 3 intentos: se escribe un
   `song.txt` mínimo de emergencia (solo advertencia + Song ID), se loguean los
   fallos y se tira una excepción → `start-flow.js` captura el exit code ≠ 0 y
   no pasa a suno-fill con datos corruptos.

**Takeaway:** para REDOs complejos (múltiples destinatarios, instrucciones largas)
1500 tokens de output no alcanzan. El fallback "si no hay título, guardar fullResponse"
convirtió un error de truncación en un archivo confuso sin señal clara de error.
La validación pre-escritura cierra esa brecha: si el contenido no tiene estructura
mínima, no se escribe como si fuera válido.

## "-- done" con espacio arrancó runFlow() en vez de runDone() (2026-06-29)

`node start-flow.js -- done` (espacio entre `--` y `done`) fue parseado por Node.js
como dos args separados: `['--', 'done']`. `process.argv.includes('--done')` busca
la cadena literal `'--done'`, que no estaba, así que `isDone` fue `false` y arrancó
`runFlow()`. El Paso 1/4 intentó `launchPersistentContext` con Chrome ya abierto (en el
mismo perfil) y crasheó con "Opening in existing browser session".

**Fix:** en la entrada de start-flow.js, `rawArgs.join('')` funde los args y detecta
si el resultado es `'--done'` o `'--poll'` sin que ninguno de los dos esté como arg
individual — en ese caso aborta con un mensaje claro antes de cualquier otra cosa.
`['--', 'done'].join('')` = `'--done'`; `['-', '-done'].join('')` = `'--done'` — ambas
variantes quedan cubiertas.

**Takeaway:** cualquier flag crítico que, si falla, arranca el modo equivocado con
Chrome ya abierto necesita su propio typo-guard en el entry point, no solo en la
documentación. El parser de Node no normaliza `-- flag` a `--flag`.

## Perfil compartido: poller cerró Chrome, pero run.js lo encontró todavía abierto (2026-06-29)

El poller anterior (poll-flow.js) cerraba su Chrome con un `sleep(2000)` fijo antes
de lanzar `start-flow.js` como subproceso. Un `sleep` fijo no garantiza que el proceso
de Chrome haya muerto y liberado el `--user-data-dir` antes de que `run.js` lo necesite.
Si el proceso tarda más de 2 segundos en morir (arranque lento, disco lento, proceso
zombie), `launchPersistentContext` se encuentra el perfil bloqueado y tira
"Opening in existing browser session".

**Fix (integración):** al integrar el poller en start-flow.js, el cierre espera la señal
concreta: `isPortUp(POLL_PORT)` pasa a `false` (el puerto cae cuando el proceso muere),
verificado con retry cada 500ms hasta 20 intentos (10s máximo). Si el puerto sigue arriba
al agotar los intentos, aborta con instrucción clara. Nunca un sleep fijo a ciegas.

**Takeaway:** antes de cualquier `launchPersistentContext` en el pipeline, verificar que
NINGÚN Chrome del perfil compartido esté vivo. "Mandé a cerrar" ≠ "está cerrado". Usar
el puerto como proxy del estado del proceso (si el puerto cayó, el proceso murió).

## readSurveyResponses devolvía 0 filas aunque la encuesta era visible (2026-06-29)

`readSurveyResponses` tiraba "No se encontraron respuestas de la encuesta en la
página" en todas las corridas. El selector `div.bg-gray-50.border.rounded.p-3.text-sm.space-y-1 > div`
era correcto y funcionaba en scripts de inspección con espera explícita, pero run.js
llamaba `page.evaluate()` inmediatamente después de que `enterFlowAndEnsureAssignment`
retornaba.

Root cause: `#lyrics` es un `<textarea>` presente en el HTML inicial (server-rendered),
por eso `waitForLyrics` lo encuentra rápido. Pero las respuestas de la encuesta se
cargan vía una API call asíncrona que React hace al montar el componente, y llegan
un instante después. El `page.evaluate()` en `readSurveyResponses` corría antes de
que esa carga terminara y encontraba 0 filas.

**Fix:** `readSurveyResponses` ahora hace `waitForSelector` para la primera fila de
la encuesta antes del `evaluate()`. Si el selector tarda > 15 segundos, devuelve `[]`
y deja que el chequeo de la línea 811 tire el error descriptivo. Verificado con
`node run.js` completo en la misma sesión.

**Takeaway:** `waitForLyrics` (que detecta `#lyrics`) NO garantiza que las secciones
de datos del Flow (Survey Responses, Song ID) estén cargadas — el textarea está en
el HTML inicial pero los datos de la encuesta son async. Cualquier lectura de
secciones dinámicas del Flow necesita su propio `waitForSelector` sobre el elemento
que realmente necesita, no un timeout fijo ni confiar en que otro campo ya está listo.

## start-flow Paso 4/4 falló: lógica de "Enter Flow + Assign" duplicada y divergente (2026-06-28)

`start-flow.js`'s `openFlowTab()` raised "No se encontró #lyrics en el Flow
después de Enter Flow" on a run where there was already an active assignment.
Root cause: there were TWO copies of the "enter the Flow and make sure an
assignment is loaded" logic. `run.js` had the complete version (Enter Flow →
wait → check `#lyrics` → if missing, click "Assign Most Urgent Song"), but
`start-flow.js`'s `openFlowTab()` had an incomplete copy that clicked Enter
Flow, checked `#lyrics` once, and gave up — it never clicked "Assign Most
Urgent Song". So whenever the Flow tab had been left at the landing state
(run.js closes its own Chrome at the end, shared profile), Paso 4 died.

**Fix:** extracted the canonical logic into `lib/flow-helpers.js`
(`enterFlowAndEnsureAssignment`) with retry/backoff, and made BOTH run.js and
start-flow.js import it. Single source of truth — they can't diverge again.

**Takeaway:** any piece of flow-navigation logic that lives in more than one
script is a divergence bug waiting to happen. When run.js and start-flow.js
(or any two scripts) need the same browser dance, it goes in `lib/`, not
copy-pasted. Also added `lib/pipeline-state.js` (state.json) so later steps can
detect if they're about to process a different song than the one generated.

## Checklist validator rejected "N/A" on a conditional item, burning all 3 attempts (2026-06-20)

The system prompt's checklist template has `Destinatarios múltiples
balanceados (si aplica): ✓/✗` — the "(si aplica)" means the item is
conditional, and for a single-recipient song (most of them) the only honest
answer is "N/A", not "✓". `hardValidate()`'s checklist check only accepted
lines containing a literal `✓`, so every single-recipient song got this
item flagged as a self-reported failure and burned all 3 regeneration
attempts before saving with the "no pasó la validación" warning banner —
even though the lyrics were correct from attempt 1.

**Fix:** lines containing `(si aplica)` are now also allowed to pass with
`N/A` (case-insensitive), as long as they don't also contain `✗`. Other
checklist lines still require a literal `✓`, unchanged.

**Takeaway:** any checklist item phrased as conditional ("si aplica") needs
its own pass condition in `hardValidate()` — don't assume every item reduces
to the same ✓/✗ binary just because the template prints `✓/✗` for all of
them.

## REDO chain-of-thought preamble leaked into song.txt, checklist symbol mismatch hid a real flag (2026-06-19, "Harry jode" song)

On a REDO with a structurally broken original (extra Pre-Coro/Puente sections),
Claude's response opened with several paragraphs of visible reasoning ("I need
to fully restructure this song because...") *before* the `**Título:**` block —
violating the system prompt's "no extra text before or after" rule. Nothing in
`hardValidate()` checked for this, so it passed on attempt 1 and the entire
preamble got saved straight into `song.txt` (parseSections' regex only looks
for `[Verse 1]` etc. so structural checks didn't notice; `suno-fill.js` also
parses by regex so the Suno form itself came out fine — only the on-disk file
was polluted).

Separately, the same response flagged a verbatim-quote violation (rule 13:
never quote survey dialogue directly — here a literal bathroom-singing chant)
using `⚠️ REVISAR MANUALMENTE` instead of `✗` in its own QA checklist.
`hardValidate()`'s checklist check only matched the literal `✗` character, so
this self-reported issue silently passed instead of triggering a regen.

**Fix:** `hardValidate()` now (a) fails if there's any non-empty text before
`**Título:**`, and (b) treats any checklist line that isn't a clean `✓` as a
failure, not just lines containing `✗`. `run.js` also now slices the saved
content starting at `**Título:**` defensively, even if validation is
exhausted and saved with a warning.

**Takeaway:** don't assume Claude's self-grading uses only the two symbols
shown in the prompt template (`✓`/`✗`) — validate by absence-of-pass, not
presence-of-a-specific-fail-symbol. Also: structural regex checks that scan
for markers anywhere in the text (by design, for robustness) can mask a
"there's text where there shouldn't be" bug — that needs an explicit check of
its own.

## "Priority Delivery" banner false-positived as REDO (2026-06-19)

`run.js`'s `isRedo` check tested for `div.bg-orange-50.border-orange-200` —
but that's not a REDO-specific selector. The unrelated "Priority Delivery"
banner (🚀 "This song was purchased with priority delivery") uses the exact
same orange classes and has no feedback box inside it. A priority-delivery
song with no REDO history hit the banner check, set `isRedo = true`, then
crashed in `readRedoFeedback()` because there's nothing to read.

**Fix:** call `readRedoFeedback()` first and derive `isRedo` from whether it
actually found feedback text (`div.whitespace-pre-wrap` inside the banner),
instead of from the banner's color classes alone.

**Takeaway:** any orange/red/green "status banner" class names on this site
are reused across unrelated states — never key detection logic off color
classes alone, always require the specific content/structure that only the
intended state has.

## CDP gotcha confirmed in practice (2026-06-19): run.js killed an open Suno window

The shared-profile risk documented below ("CDP lifecycle pattern") actually
fired: a Suno fill was sitting open (post-Create, screenshots already taken)
on port 9333 when `run.js` ran for the next song. `run.js`'s `finally` block
unconditionally calls `activeContext.close()` on its `launchPersistentContext`
— and since Chrome's singleton behavior makes that call attach to the
*already-running* process (same `user-data-dir`), closing it tore down the
whole shared browser, killing the debug port and the open Suno tab with it.

**Recovery:** just re-run `suno-open-for-login.js` and `suno-fill.js` — login
persists because session cookies live in the on-disk profile, not in the
closed process.

**Takeaway:** "Hector ya clickeó Create" does NOT make it safe to run `run.js`
while that Chrome window is still open. The only safe sequencing is: close/let
go of the Suno window first (or don't open it via `suno-open-for-login.js`
until right before the fill step), *then* run `run.js`. Treat any live Suno
tab as a hard blocker until it's done being used, not just "Create was already
clicked."

## "Mezcla de trato" validator false-positives inside longer words

`hardValidate()`'s usted-mismatch check used `\bvení\b`, `\bdecí\b`, etc. — but
JS regex `\w`/`\b` don't treat accented vowels (á é í ó ú ñ) as word
characters. So `\b` fires right after the í in "ven**í**a" or "dec**í**rselo",
making "vení"/"decí" match *inside* those completely correct, usted-consistent
words. This burned all 3 regen attempts on a real run even though the lyrics
had zero actual tú/vos mixing — the model kept "fixing" something that wasn't
broken until it gave up and saved with a warning.

**Fix:** replaced `\b` with explicit negative lookahead/lookbehind against the
accented-letter class (`(?<![a-záéíóúñ])...(?![a-záéíóúñ])`) so the boundary
check actually respects Spanish word characters.

**Takeaway:** any regex-based Spanish text validator using `\b` is suspect —
audit the others (estilo Suno checks, etc.) for the same accented-boundary gap.

## Multi-recipient surveys broke name validation entirely

`hardValidate()`'s name check used to grab the survey's "What's their name?"
field and take its *first word* as the dedicatee's name. For a single name
("Frank") that works. For a multi-recipient survey ("Mis hijos Christopher y
Soraya.") it took **"Mis"** as the name — then told the model on every retry
that "Christopher" and "Soraya" (correctly used per the MULTIPLE RECIPIENTS
prompt rule) were wrong and must be replaced with "mis". After 3 contradictory
correction rounds the model gave up and dumped raw chain-of-thought reasoning
into the response instead of a song, which got saved straight into `song.txt`.

**Fix:** extract candidate names by filtering out a filler-word list (mis, mi,
hijo, hija, hijos, hijas, y, and, su, sus, el, la, los, las, de, del) instead
of assuming the first word is the name. Validate each chorus's opening word
against the *set* of names, not a single fixed one.

**Takeaway:** any time the system prompt grows a new structural rule (multiple
recipients, parent format, phonetic respelling, etc.), check whether
`hardValidate()`'s assumptions still hold — it was written before any of those
existed and silently assumed exactly one recipient with no respelling.

## Suno fill scripts pasted `**Advertencias:**` into the lyrics box

When the `Advertencias` field was added to `song.txt`'s format, `suno-fill.js`
(then `suno-fill2.js`) still parsed "everything between `[Verse 1]` and
`NOTES:`" as the lyrics — which now included the Advertencias paragraph in
between. It got typed straight into Suno's lyrics textarea. Caught by the
required visual-verify screenshot before clicking Create, not by any
programmatic check.

**Fix:** stop the lyrics slice at whichever comes first, `**Advertencias:**`
or `NOTES:`.

**Takeaway:** the visual verify-before-Create step is not a formality — it's
caught a real defect every time it's been used so far. Never skip it.

## "Assign Most Urgent Song" — click target vanishes mid-click

After clicking "Enter Flow", the page briefly renders a default/loading state
(sometimes showing the "Assign Most Urgent Song" button) before client-side
code confirms whether an assignment is already active and swaps to the real
view. A script that checks for the button immediately and clicks it can be
clicking an element that's about to be replaced — Playwright reports "element
was detached from the DOM, retrying" and eventually times out. This is
deterministic (not flaky) whenever there's already an active assignment from
a previous session.

**Fix:** wait ~2s after "Enter Flow" for the page to settle, then check for a
concrete signal that an assignment is loaded (`#lyrics` field present) instead
of checking for the *absence* of the assign button.

## Toggling a panel that might already be open (e.g. Suno's "More Options")

Blindly clicking a show/hide toggle assumes a known starting state. On a
retry (form already filled once), the panel can already be expanded, and the
naive click collapses it instead — then the next step (clicking "Female"/
"Male" inside it) fails because the button is now hidden.

**Fix:** check whether the element you actually need (e.g. the gender button)
is already visible before clicking the toggle. See
`lib/playwright-helpers.js`'s `expandIfCollapsed`.

## CDP lifecycle pattern (Chrome automation that must survive logins / stay open)

- Launch Chrome as a **plain OS process** (`spawn`/`Start-Process`), not via
  Playwright's `launchPersistentContext`, when the session needs to survive a
  Google OAuth login or stay open after the script exits.
  - Playwright's automation flags (`--enable-automation`,
    `--remote-debugging-pipe`) make Google's OAuth flow show a "this browser
    may not be secure" block. A plain launch with a fixed
    `--remote-debugging-port` avoids it.
  - `launchPersistentContext` ties the browser's life to the controlling Node
    process via the debugging-pipe transport — closing/exiting that process
    closes Chrome too, even with a keep-alive promise.
- Chrome refuses remote debugging if `--user-data-dir` points at the literal
  default Chrome profile dir — needs a dedicated automation profile dir.
- Short-lived scripts then just `chromium.connectOverCDP('http://localhost:<port>')`,
  do their work, and disconnect (`browser.close()` on a CDP-attached browser
  just disconnects, it's safe).
- Gotcha: two scripts sharing the same `--user-data-dir` + `--profile-directory`
  can hijack/close each other's window due to Chrome's singleton behavior —
  don't run `run.js` while a Suno fill session needs to stay open.

## Flaky page-transition retries

Occasional one-off timeouts on button clicks during page transitions (survey
read finds 0 rows, or a generic detach-retry) have so far always been resolved
by simply rerunning the script. Worth distinguishing from the deterministic
"Assign Most Urgent Song" bug above — if the *same* script fails the *same*
way 2-3 times in a row, that's a real bug, not flakiness; investigate instead
of just retrying again.

## Model IDs and API params guessed from training data instead of verified

Over one session, `lib/llm-provider.js` got "fixed" three separate times by
assuming instead of checking: removed `cache_control`'s `ttl: '1h'` believing
it was an invalid field breaking Anthropic's prompt caching (it's real,
documented syntax — removing it just silently shortened the cache window from
1h to the 5min default); hardcoded a "Haiku → Sonnet" cost-escalation strategy
using `claude-3-5-haiku-20241022` and `claude-3-5-sonnet-20241022` (both
retired Anthropic snapshots — every real API call 404'd); and separately,
`gemini-2.0-flash` sat hardcoded in the same file's Gemini branch, unnoticed
because attention was on the Anthropic branch, months after Google shut that
model down (would also 404 on every real call, silently, since Gemini was
never the default provider being tested).

**Fix:** verified every claim against live sources before touching the file
again — the `claude-api` skill's cached model table for Anthropic, WebSearch +
WebFetch for Gemini (no skill covers non-Anthropic providers). Corrected to
`claude-sonnet-5`, restored `ttl: '1h'`, dropped the Haiku escalation
entirely, updated to `gemini-3.5-flash`.

**Takeaway:** model ID strings and API parameter names are exactly the kind of
detail that looks plausible and is quietly wrong — a training-data guess reads
identically to a correct answer until the API 404s in production. Before
touching a model ID, a `cache_control`/`thinking`/other API-shape parameter,
or "is X still current" for *any* provider (Anthropic or otherwise), verify
against a live source first. Never assume a change someone describes as
"corrected" or "restored" is actually reflected in the file — read it back.

## browser.close() sobre connectOverCDP NO mata Chrome — pero NO llamarlo cuelga Node para siempre

Al hacer el pipeline "no cerrar nunca Chrome" (2026-07-02) se quitaron todos
los `browser.close()` de los scripts que se conectan por CDP (run.js,
suno-fill.js, suno-create.js, upload-to-flow.js), creyendo que `.close()` en
Playwright sobre CDP terminaba el proceso de Chrome. Resultado real: el
websocket CDP abierto mantiene vivo el event loop de Node, así que cada script
quedaba COLGADO al terminar — y como start-flow.js espera el exit de cada hijo
(`runScript`), el pipeline entero se atascaba en silencio en el Paso 1.

**Verificado empíricamente (Playwright 1.61.0, Chrome 149, Windows):**
- `connectOverCDP` sin `browser.close()` → Node nunca sale (colgado, hay que matarlo).
- `browser.close()` tras `connectOverCDP` → Node sale limpio y **Chrome sigue
  corriendo intacto** (solo se desconecta el socket; el puerto de debug sigue
  respondiendo). Es el comportamiento documentado de Playwright para browsers
  "connected to" (distinto de `launch()`/`launchPersistentContext`, donde
  `close()` SÍ termina el navegador).

**Regla:** todo script que use `connectOverCDP` debe terminar con
`await browser.close().catch(() => {})` (o `process.exit()`). Eso desconecta
sin tocar Chrome. La confusión histórica venía de `launchPersistentContext`,
donde `context.close()` sí cierra la ventana — ese es el motivo del patrón
"Chrome standalone + connectOverCDP", no un supuesto peligro de `browser.close()`.

## Nombre corto que colisiona con una palabra española común ("Al") quemaba los 3 intentos de generación

Incidente real (2026-07-04, `logs/run-2026-07-04T01-11-07-151Z.log`): con
nombre de encuesta "Al", los 3 intentos de `generateSongWithSelfCorrection`
fallaron con el mismo error idéntico: `[Verse 1] contiene el nombre "al" —
debe estar ausente`. La letra generada era correcta — Verse 1 tenía la línea
"Ibas con tu amiga Martha sonriendo **al** caminar", donde "al" es la
contracción española de "a"+"el" (preposición), no el nombre. El chequeo C de
`hardValidate` (`lib/song-validate.js`) usaba `.includes()` case-insensitive
sin límite de palabra, así que CUALQUIER "al" en Verse 1 —la preposición, o
substrings dentro de "cristal"/"final"/"igual"— disparaba el fallo. Con un
nombre de 2 letras que coincide con una palabra gramatical de altísima
frecuencia en español, es prácticamente imposible que el LLM evite el string
"al" en 4 líneas de verso natural — los 3 reintentos con instrucciones
correctivas estaban condenados desde el intento 1, porque el problema nunca
fue el contenido generado.

**Fix aplicado:** el chequeo C ahora compara **case-sensitive contra la forma
capitalizada** del nombre (`Al`, no `al`), sobre el texto de Verse 1 SIN pasar
a minúsculas, con límite de palabra consciente del español (`nameRegex` en
`lib/song-validate.js`, compartida ahora por los chequeos B/C/multi-recipient
que antes tenían 3 varas distintas — `.includes()`, `.split()`, y un
`nameRegex` local solo en el camino multi-destinatario). Un nombre que de
verdad se filtra en Verse 1 casi siempre aparece capitalizado (se dirige/
refiere a la persona); la preposición española nunca lo está salvo al inicio
de oración — caso raro que queda sin cubrir, pero muchísimo más angosto que
disparar con cualquier "al" en cualquier posición. Casos cubiertos en
`test/song-validate.test.js` ("nombre corto que colisiona con una palabra
común", "nombre corto SÍ capitalizado... sigue detectándose como fuga",
"conteo de ocurrencias... no se infla por substring").

**Nota separada (pronunciación, no validación):** el mismo nombre "Al" tenía
otro problema real en Suno — lo canta con una "H"/"J" fantasma al inicio
("Jal"/"Hal"). Confirmado empíricamente que reescribirlo duplicando la vocal
inicial ("Al" → "Aal") lo arregla; se agregó como regla explícita en el
`SYSTEM_PROMPT` de `run.js` (sección PHONETIC RE-SPELLING). Es la misma regla
que existía en el prompt original (`54dd609`, ejemplo "Alma" → "Halma" →
"Aalma"/"Al-ma") y se había perdido sin querer al reescribir esa sección a
fonética española en el commit `251c5b5` — no fue una decisión deliberada,
quedó afuera como efecto colateral. Si vuelve a aparecer un nombre corto o
vocal-inicial con este problema, probar primero la duplicación de vocal antes
de inventar una respelling nueva desde cero.

## `verify-audio.js` daba OK en un nombre realmente mal pronunciado — Whisper con `initial_prompt` se autocorrige

Mismo incidente que la sección anterior: aparte del bug de validación, el
nombre respelled ("Áll") seguía sonando con la "H"/"J" fantasma en el audio
real de Suno, y sin embargo `verify-audio.js` no lo marcó como problema —
`missingNames` dio vacío, o sea "presente y OK". Investigado: el chequeo de
nombres (`isNameInTranscription`) solo compara la TRANSCRIPCIÓN de Whisper
contra el nombre esperado, y en modo `--demucs` esa transcripción corre con
`initial_prompt` = la letra completa (para evitar alucinaciones sobre canto,
ver comentario en `lib/audio-analysis.js` desde antes de este fix). Efecto
secundario nunca antes explotado en código: ese prompt sesga a Whisper a
"escuchar" la palabra que ya sabe que está buscando, así que puede transcribir
"Al" aunque el audio real tenga un sonido inicial distinto — Whisper nunca es
un juez de pronunciación, es un ASR con modelo de lenguaje detrás.

**Investigación de alternativas** (fonemas agnósticos al idioma tipo
Wav2Vec2Phoneme, GOP/Goodness-of-Pronunciation, WhisperX con alineación
forzada) confirmó que existen soluciones más rigurosas, pero requieren modelos
nuevos (descarga, dependencias nuevas tipo `phonemizer`/`espeak-ng`) — riesgo
alto para un pipeline en producción. Se optó por el fix de menor riesgo que
ataca la misma causa raíz sin dependencias nuevas.

**Fix aplicado (`lib/audio-analysis.js`):** `verifyNamePronunciation` — para
cada nombre que la transcripción principal SÍ dio por presente, recorta
(ffmpeg) la ventana exacta de esa palabra (timestamps que Whisper ya da) y la
re-transcribe en un proceso APARTE, SIN `initial_prompt`. Si esa segunda
pasada, libre del sesgo de la letra, no confirma el nombre, se guarda en
`report.nameAudioChecks` (`confirmed: false`) — informativo, nunca cambia
`missingNames` directamente, pero sí resta 15 pts en `pickBestVersion`
(mismo peso liviano que CLAP). El clip de ~1-2s queda en
`<carpeta del mp3>/name-check/<archivo>-<nombre>.wav` para que confirmar de
oído sea cuestión de segundos, no de escuchar la canción entera — el reporte
siempre dijo "confirmá con tu oído" pero antes no había forma barata de
hacerlo. Cero dependencias nuevas: reusa `transcribeFiles`/`ffmpeg`, ya
presentes para la transcripción principal y para corte abrupto/clipping.
Cubierto en `test/audio-analysis.test.js` (penalización en `scoreReport` +
que un reporte sin `nameAudioChecks`, forma vieja del objeto, no rompa).

**Si esto no alcanza** (sigue habiendo falsos "confirmado" en el futuro): el
siguiente paso investigado y descartado por ahora es un modelo de fonemas
agnóstico al idioma (ej. `facebook/wav2vec2-lv-60-espeak-cv-ft`) comparado
contra un G2P español (`espeak-ng`) por distancia fonética — ataca la causa
raíz de forma más rigurosa (GOP/Goodness-of-Pronunciation, el estándar
académico), pero implica nuevas dependencias de Python y un modelo a
descargar; evaluar solo si el problema se vuelve recurrente pese a este fix.

## Descarga A/B en paralelo se robaban el archivo entre sí — ENOENT en cualquiera de las dos (2026-07-04)

Visto en vivo varias veces ("Nuestro Pacto Eterno", "Gracia que nos sostuvo"
x2, "El Vestido Rojo"): una de las dos versiones se descargaba bien y la otra
tiraba `ENOENT: no such file or directory, stat '...'` sobre SU PROPIO
destino. Al principio pareció ser siempre A la víctima (y B el "ladrón"), pero
en "El Vestido Rojo" pasó al revés (A "ganó" con contenido que en realidad
era el de B, B quedó con el ENOENT) — la dirección no es fija, es una carrera
real de timing.

**Causa raíz (versión completa):** la paralelización de A/B (ver entrada
anterior, "Descarga de A y B en serie...") hace que ambos `watchForNewMp3`
vigilen la MISMA carpeta al mismo tiempo, cada uno con su propia "foto" de
archivos existentes tomada en un momento distinto. Si ninguno de los dos
archivos reales había aterrizado todavía cuando se tomaron ambas fotos, los
dos watchers ven los mismos .mp3 nuevos como candidatos — y acá había DOS
huecos, no uno:

1. **Fuente compartida:** ambos podían reclamar el mismo archivo recién
   llegado (el .mp3 tal como lo bajó el navegador). Primer fix: `claimedPaths`
   (`Set` compartido) marca la fuente apenas un watcher decide actuar sobre
   ella, sincrónicamente, sin ningún `await` de por medio (Node es
   single-threaded, así que no hay ventana real de carrera entre el chequeo y
   el reclamo si ambos ocurren en el mismo tick).

2. **Destino ya renombrado, redescubierto como "nuevo" (el hueco que faltaba):**
   ese primer fix NO alcanzaba. Cuando el watcher de B renombraba su archivo a
   `"... B.mp3"`, ese nombre NUNCA HABÍA EXISTIDO antes — así que si el
   watcher de A todavía seguía corriendo (su propio archivo real seguía sin
   llegar) y hacía un poll DESPUÉS de ese rename, veía `"... B.mp3"` como
   candidato "nuevo" (no estaba en la foto de A, y `claimedPaths` solo tenía
   la fuente original, no el destino). A lo reclamaba y lo volvía a renombrar
   hacia SU propio destino limpio — robándole a B el archivo que ya había
   resuelto. B terminaba con una promesa ya resuelta apuntando a un archivo
   que un instante después dejó de existir (ENOENT), y A terminaba "exitoso"
   pero con el contenido que en realidad era la generación de B.

**Fix completo:** `finish()` ahora agrega TANTO la fuente como el destino
resuelto (`resolvedDest`) a `claimedPaths`, en el mismo tick sincrónico en que
decide actuar. Así, un archivo ya colocado en su destino final por un watcher
queda inmediatamente protegido de ser "redescubierto" por cualquier otro.

**Sin test automático a propósito** (mismo criterio que el resto de este
archivo para bugs de timing de filesystem/Playwright real — ver
`test/suno-create-dl-config.test.js`: ese test cubre timeouts/constantes, no
el flujo de descarga en sí, que necesita Chrome/Suno real para reproducirse
de verdad). Validar en la próxima corrida real con 2 versiones generadas que
ninguna tire ENOENT, en ninguna dirección.

## Un REDO no subió nada al Flow — un fallo total de descarga (0 archivos) apagaba el resto del pipeline en silencio (2026-07-04)

Visto en vivo en un REDO ("El Vestido Rojo"): el pipeline no subió ninguna
versión al Flow — quedó lo que había antes (la canción vieja, ya rechazada
por QC), y hubo que subir a mano. Root cause en `start-flow.js`, Paso 3b: si
`createAndDownload()` (el Create inicial de la corrida, no un reroll) lanzaba
por completo — 0 archivos descargados, ninguna de las 2 versiones sobrevivió
la carrera de descargas de la entrada anterior — el `catch` solo logueaba el
error y seguía. Eso dejaba `mp3sDescargados = false` y `createdThisRun =
false` para TODA la corrida, lo cual en cascada:

1. El bucle de auto-reroll (Paso 3d) nunca corría — `while (createdThisRun &&
   ...)` es `false` de entrada, y el reroll ya requiere una descarga previa
   exitosa para poder comparar.
2. El Paso 5 (subida automática) está detrás de `if (mp3sDescargados)` —
   con `false`, se salta ENTERO. El pipeline seguía corriendo (esperaba el
   Submit to QA, etc.) pero nunca tocaba el campo de archivo del Flow.

A diferencia del reroll (que SÍ reintenta cuando el audio suena mal, pero
solo después de al menos una descarga exitosa), un fallo total en el primer
intento no tenía ningún camino de recuperación automática.

**Fix:** el Create inicial ahora reintenta hasta `MAX_CREATE_RETRIES` (2)
veces completas (re-clickeando Create de nuevo sobre el mismo formulario,
gastando créditos otra vez) si `createAndDownload()` lanza por completo — no
confundir con `MAX_REROLLS` (ese es por mala pronunciación del nombre, y
solo aplica cuando SÍ hubo alguna descarga que analizar). Si los 3 intentos
totales fallan, avisa por ntfy con prioridad `urgent` y deja instrucciones de
recuperación manual explícitas en consola (`node suno-create.js` +
`node upload-to-flow.js --version A|B`) — antes solo quedaba el mensaje
genérico de "Create manual disponible", sin explicar que NADA se había
subido.

**Sobre las "6 versiones de la misma canción":** no es un bug aparte —
es la consecuencia esperable de `--max-rerolls 2` (default): hasta 3 Creates
totales (el original + 2 rerolls) × 2 versiones por click = hasta 6
generaciones de Suno para una sola canción, cada una gastando créditos. El
bug de la carrera de descargas (entrada anterior de este archivo) lo hacía
mucho más probable de lo normal: con solo 1 versión sobreviviendo cada
intento (la otra perdida en la carrera), la chance de que "la única
disponible" no confirme el nombre y dispare OTRO reroll era mucho más alta
que si ambas versiones realmente hubieran estado disponibles para comparar.
Con el fix de `claimedPaths` (entrada anterior) debería volver a ser la
excepción, no la norma.

## Se sacó el auto-reroll por mala pronunciación (2026-07-04)

Decisión explícita de Hector tras verlo fallar en vivo: en "Treinta Años de
Camino" (nombre "Gerardo") se gastaron los 2 rerolls completos
(`--max-rerolls 2`, default) y el nombre siguió sin confirmarse
("⚠️ Rerolls agotados (2): el nombre sigue sin escucharse bien") — 3 Creates
totales, ~30 créditos, cero mejora. No fue un caso aislado: la señal de la
que depende (`missingNames`, basada en si Whisper "escucha" el nombre) ya
estaba documentada como poco confiable sobre canto, y el bug de la carrera
de descargas (entrada anterior) hacía que muchas corridas solo tuvieran 1
versión real para juzgar en cada intento, disparando el reroll más seguido
de lo que debería. En conjunto: el mecanismo no convergía a un resultado
mejor, solo gastaba créditos reales esperando que la próxima tirada de
dados saliera distinta.

**Qué se sacó** (`start-flow.js`): el flag `--max-rerolls N`, la función
`bothVersionsMissingNames()`, `quarantineRejectedMp3s()` (movía los MP3
rechazados a `Downloads/suno/rejected/`), el `while` de reroll completo, y
el mensaje post-loop de "rerolls agotados". La señal informativa se
mantiene intacta — el reporte de `verify-audio.js` sigue avisando
"nombres ausentes ⚠️" y penalizando en `pickBestVersion` cuando el nombre no
se escucha bien; lo que se sacó es SOLO la re-generación automática que
intentaba "arreglarlo" gastando más créditos sin garantía de mejora.

**No se tocó** `MAX_CREATE_RETRIES` (entrada anterior, "Un REDO no subió
nada al Flow") — mecanismo completamente distinto (reintenta el Create
INICIAL si falla del todo, 0 archivos descargados) que sigue activo igual
que antes.

**Carpeta `Downloads/suno/rejected/`:** ya no la escribe ningún código —
queda como limpieza manual opcional si Hector quiere borrar lo acumulado
de corridas viejas; no hace falta para que el pipeline funcione bien.

## Causa raíz real de los timeouts de 8 min en una de las dos versiones: el click en la SIGUIENTE card cancelaba la descarga de la ACTUAL (2026-07-04)

Después de arreglar la carrera de `claimedPaths` (entradas anteriores), seguía
pasando que una de las dos versiones se colgaba los 8 minutos completos sin
que aterrizara ningún archivo — ya no por robo entre watchers, sino porque
la descarga real nunca llegaba a completarse del lado de Chrome.

**Diagnóstico** (Antigravity, script aislado de solo lectura contra una
sesión real de Suno, 10 clicks de prueba en cards ya generadas — cero
créditos gastados): el evento nativo `page.on('download')` de Chrome SIEMPRE
se disparó (10/10), pero nunca instantáneo — tardó entre **2.6s y 6.3s**
(promedio ~4.8s) desde el click en "MP3 Audio" hasta que Chrome confirmó que
la descarga arrancó. Cero errores de consola, cero estados raros del DOM.

**Causa raíz confirmada:** en `lib/suno-create-dl.js`, `clickDownloadMp3`
clickeaba "MP3 Audio" para la Versión A y devolvía el control INMEDIATAMENTE
(el caller solo esperaba `page.waitForTimeout(1500)` — 1.5s) antes de pasar
a abrir el menú de la Versión B. Como Suno tarda hasta 6.3s en preparar el
archivo, tocar la UI de B (abrir su menú ⋯, Escape, etc.) **antes** de que
la descarga de A terminara de dispararse la cancelaba en silencio del lado
del navegador — sin ningún error visible, simplemente el archivo nunca
llegaba a existir, y el watcher de filesystem esperaba los 8 minutos completos
por algo que Chrome ya había abortado en los primeros segundos.

**Fix:** `clickDownloadMp3` ahora arma un listener de `page.on('download')`
ANTES de intentar el click (no después — el click puede ocurrir en cualquier
vuelta del bucle de reintentos por "not-ready", así que el listener tiene
que estar activo desde el arranque para no perderse el evento), y una vez
clickeado espera esa confirmación real (`DOWNLOAD_START_CONFIRM_TIMEOUT_MS`,
20s — margen de sobra sobre el máximo de 6.3s medido) antes de devolver el
control al caller. Recién ahí el caller pasa a tocar la próxima card. Si
Chrome no confirma en 20s, se loguea una advertencia pero se sigue igual.
(Nota post-migración a `download.saveAs()`, ver entrada siguiente: en el
momento en que se escribió esto el watcher de filesystem seguía siendo la
fuente de verdad de "el archivo está completo en disco" — ya no existe,
reemplazado por completo.)

**Sobre el uso de Antigravity acá:** primera vez que se usó para reproducir
un bug en vivo con clicks reales (no solo lectura de selectores) — seguro
porque "Download → MP3 Audio" no gasta créditos de Suno (a diferencia de
"Create"). Las reglas duras (nunca Create, nunca Submit to QA, solo cards ya
generadas, reporte en Markdown) se respetaron.

## Migración completa a la API nativa de descargas de Playwright — se acabó el watcher de filesystem (2026-07-04)

El fix anterior (esperar `page.on('download')` antes de tocar la próxima
card) redujo el problema pero no lo cerró del todo — Antigravity encontró en
vivo que seguía habiendo timeouts de 8 min esporádicos. Causa raíz definitiva:
mientras exista CUALQUIER mecanismo que vigile una carpeta compartida y trate
de adivinar "cuál archivo nuevo es de quién" (snapshots, `claimedPaths`,
lo que sea), siempre va a quedar una ventana de ambigüedad entre A y B.

**Fix (reemplazo total, no un parche más):** `lib/suno-create-dl.js` ya no
vigila ninguna carpeta. `clickDownloadMp3` devuelve directamente el objeto
`Download` nativo de Playwright (capturado vía `page.on('download')` antes
del click, igual que antes) en vez de un booleano; la fase de guardado usa
`await download.saveAs(destPath)`, que Playwright resuelve solo cuando la
descarga terminó de verdad — sin polling, sin `fs.watch`, sin comparar
nombres. Cada `Download` es una referencia inequívoca a UNA descarga
concreta: A y B nunca pueden confundirse entre sí porque no hay ningún
estado compartido que consultar. Se eliminaron `watchForNewMp3` y
`claimedPaths` por completo. El fallback manual (`awaitManualDownload`)
también migró: un click humano en "MP3 Audio" dispara el mismo evento
`page.on('download')` que uno automatizado, así que no hace falta ningún
mecanismo aparte para detectarlo tampoco ahí.

**Riesgo nuevo que había que cubrir:** `saveAs()` no tiene timeout propio —
si una descarga se estancara a mitad de camino quedaría colgado para
siempre. Se envolvió en un `Promise.race` contra el mismo techo de 8 min
(`DOWNLOAD_WAIT_TIMEOUT_MS`) que tenía el watcher que reemplaza, para no
perder esa garantía.

**Diagnóstico y arreglo, ambos de Antigravity** (revisados acá antes de
aplicar, como siempre) — la explicación técnica completa (con el paso a paso
del bug de nombres duplicados) fue el material fuente de este fix.

## Cinco hallazgos más de Antigravity, revisados y aplicados juntos (2026-07-04)

Mismo día, mismo patrón (Antigravity diagnostica, Claude verifica contra el
código real antes de aplicar). Los 5 se confirmaron ciertos leyendo el
código — ninguno se aplicó a ciegas.

**1. 🔴 Poller ciego en sequía (`start-flow.js`, `pollOnce`) — el más
importante de los 5.** `pollOnce` solo cerraba la pestaña en el camino de
éxito (`found: true`). Si la cola estaba vacía, la pestaña quedaba abierta
sin cerrar; el siguiente poll la reutilizaba con `navigate: false`, y
`enterFlowAndEnsureAssignment` con ese flag lee el DOM tal cual está, sin
recargar nunca. Si una canción nueva caía en la cola mientras tanto, el
poller nunca la iba a detectar — se quedaba mirando la misma foto vieja del
DOM indefinidamente. **Fix:** si se reutiliza la pestaña, se recarga
(`page.reload()`) siempre antes de chequear, sin importar qué pasó en el
poll anterior.

**2. 🟡 `titleMatchScore` fallaba con títulos cortos (`lib/audio-match.js`).**
El filtro de palabras >2 caracteres dejaba `words` vacío para títulos como
"Fe" o "A ti" (todas sus palabras ≤2 chars), y el score daba 0 SIEMPRE sin
importar el archivo — un título corto nunca podía matchear nada, aunque el
MP3 correcto estuviera bien guardado en disco. Baja probabilidad (los
títulos generados suelen ser frases descriptivas), pero cuando pasa es un
fallo duro. **Fix:** si el filtro deja la lista vacía, usar todas las
palabras sin filtrar en vez de rendirse. Cubierto en
`test/audio-match.test.js` (nuevo).

**3. 🟡 Normalización inconsistente en `readRecentCompletion`
(`start-flow.js`).** Tenía su propia función `normalize` local que NO
limpiaba signos de puntuación, a diferencia de la centralizada en
`lib/audio-match.js`. Un título con puntuación (ej. "Mi lugar seguro." con
punto final) que Suno renderizara sin ese punto en la card fallaba la
comparación por una simple diferencia de puntuación, no por ser una canción
distinta — abortaba el auto-registro en Sheets sin necesidad (quedaba el
fallback manual de `--done`, así que no se perdía nada, pero era molesto).
**Fix:** usar la `normalize` centralizada (importada) en vez de la copia
local.

**4. ⚪ Comparación estricta de títulos en el Paso 5 (`start-flow.js`).**
`report.titulo === currentTitulo` sin normalizar — cualquier diferencia
mínima de mayúsculas/espacios/puntuación entre `state.json` y
`verify-report.json` hacía que se ignorara el reporte de análisis (ya había
un fallback sano: "sube B por defecto", así que el impacto era bajo).
**Fix:** misma normalización que el punto 3, aplicada acá también.

**5. ⚪ Crash de salida en Windows (`flow-submit.js`, `upload-to-flow.js`).**
`run.js` ya tiene `exitAfterDelay()` (250ms antes de `process.exit()`) para
evitar un crash de libuv ("Assertion failed:
!(handle->flags & UV_HANDLE_CLOSING)") verificado empíricamente cuando se
cierra un socket CDP y se llama `process.exit()` en el mismo tick. Nunca se
replicó en los otros dos scripts que también hablan CDP. No se vio este
crash específico en ningún log de esta sesión — es preventivo, no la
reproducción de un incidente real. **Fix:** mismo helper `exitAfterDelay`
copiado a ambos archivos, reemplazando todos los `process.exit()`.

**Verificación:** `npm test` (80 casos, 5 nuevos de `audio-match.test.js`) y
`node start-flow.js --dry-run` (circuito completo sin API real) corridos
después de los 5 cambios — todo limpio.

## "Maria" sin tilde sobrevivió 3 intentos de regeneración — el corrector barato nunca se activó (2026-07-13)

**Caso real:** "El Lago Donde Aprendí a Quedarme". El nombre del
destinatario es "Maria"/"María". `hardValidate` detectó correctamente
"maria" (sin tilde) en Chorus 1/2/Outro los 3 intentos seguidos — el
chequeo H2 (`Eñe/tilde perdida`, patcheable) nunca falló en detectarlo. El
problema es que el chequeo M (nombres españoles estándar, backstop del bug
"Jesús"→"Yeous" del 2026-07-10) TAMBIÉN reportaba un fallo aparte
("posible re-escritura indebida") por el mismo typo, porque "María" con
tilde no aparecía literalmente en la letra. Ese fallo de M no está en
`PATCHABLE_FAILURE_PREFIXES` a propósito (cubre respellings genuinos, no
simples typos) — así que `isSafeToPatch` veía un fallo no-patcheable en la
mezcla y se saltaba el corrector barato (Haiku) por completo, yendo directo
a un regen completo con el modelo caro. Ese regen completo (con
instrucciones correctivas explícitas) falló 3/3 veces en corregir el mismo
typo — la 2ª pasada arregló la tilde pero rompió el conteo de líneas del
Chorus, y la 3ª volvió a escribir "Maria" sin tilde. Tras los 3 intentos el
pipeline siguió de largo con el banner `⚠️ ADVERTENCIA` (diseño correcto:
nunca se traba), y la letra con el typo llegó hasta el campo de Letra del
Flow antes de que Hector lo notara.

Segundo hallazgo en la misma sesión: "El Guardia" (Ollama, Capa 3) está
gateado con `if (passedQA && ...)` — nunca corrió sobre esta canción
porque `passedQA` fue `false` los 3 intentos. Justo la canción que más
necesitaba una segunda opinión se quedó sin ella. Pedido explícito de
Hector: "OLLAMA SIEMPRE CORRA no a veces SIEMPRE" — Ollama es local y
gratis, no hay costo real en correrlo también sobre letras con warning.

**Fix (3 cambios, `lib/song-validate.js` + `run.js`):**
1. El chequeo M ahora se salta si la forma SIN acentuar del nombre canónico
   ya aparece en la letra (`stripAccents(canonical)` con `nameRegex`) — en
   ese caso es el MISMO typo que H2 ya va a reportar (y ya es patcheable),
   no un respelling distinto que amerite un fallo separado no-patcheable.
   M sigue disparando normalmente para el caso real que lo originó
   ("Yeous", que no comparte ninguna forma con "Jesús" sin acentuar).
2. El Guardia (`run.js` línea ~1105) ahora corre con solo `if (parsedJson?.letras)`
   — sin el `&& passedQA` — así que también opina sobre letras que se
   guardaron con `⚠️ ADVERTENCIA`. Sigue sin bloquear nunca por sí solo más
   allá del gate real que ya existía (pausa si el Guardia rechaza).
3. **Pedido explícito de Hector, en la misma sesión** ("se ve el error pero
   no lo arregla", "quiero que la validación SIEMPRE PASE"): no basta con
   destrabar el corrector barato de Haiku — sigue siendo un LLM, sigue
   pudiendo fallar. Se agregó `applyDeterministicAccentFixes` en
   `lib/song-validate.js`: para los typos donde `findAccentTypos()` YA
   encontró una sola sustitución válida en el diccionario (sin ambigüedad),
   hace un reemplazo de texto DIRECTO (regex + `nameRegex`, preserva
   mayúscula inicial) — cero LLM, cero costo, cero posibilidad de que el
   modelo "se olvide" de la corrección. Corre en `run.js` inmediatamente
   después de cada `hardValidate()` fallido, ANTES del corrector de Haiku:
   si el reemplazo mecánico solo ya deja la letra limpia, ni siquiera hace
   falta gastar Haiku. Si quedan issues no cubiertos por este corrector
   (dígitos, puntuación, etc.), el flujo sigue exactamente igual que antes
   (Haiku → regen completo).

**Verificación:** `npm test` (232 casos, 3 nuevos — "Maria" sin tilde ya no
duplica el fallo M, `applyDeterministicAccentFixes` corrige preservando
mayúscula y deja pasar `hardValidate`, y no toca nada si no hay typos). No
se corrió en vivo contra Suno/Claude todavía — el próximo REDO o canción
nueva con un typo de tilde real confirma el corrector determinístico en
producción.

## El fix de "Maria" abrió un agujero para "Jesus"/"Jose" — suprimir un fallo asumiendo que otro chequeo lo cubre, sin verificarlo (2026-07-13)

**Caso real (encontrado en revisión profunda con Fable, mismo día del fix
anterior — nunca llegó a producción):** el punto 1 del fix de arriba
SUPRIMÍA el fallo del chequeo M cuando la forma sin acentuar del nombre
canónico estaba en la letra, asumiendo que H2 (`Eñe/tilde perdida`) "ya lo
reporta". Esa suposición nunca se verificó, y es FALSA para la mayoría de
los nombres: H2 depende de que nspell acepte la variante acentuada en
MINÚSCULA, y dictionary-es solo trae así unos pocos nombres propios
("maría" sí — por eso el caso del bug original funcionaba —, "jesús",
"josé", "sofía", "andrés"... NO). Verificado contra la lista completa:
**42 de los 58 nombres acentuados de `standard-spanish-names.json` eran
invisibles para H2** — con esos, M se suprimía, H2 callaba, y "Jesus" o
"Jose" sin tilde pasaban `hardValidate` ENTERO en silencio (confirmado con
un end-to-end: cero fallos). En un negocio de canciones cristianas, "Jesús"
es probablemente la palabra en riesgo más frecuente de todo el pipeline.
Antes del fix, ese caso al menos disparaba M y forzaba un regen; el fix lo
convirtió en un pase limpio. Un fallo detectado que molesta NUNCA se
suprime — se RECLASIFICA.

**Fix (`lib/song-validate.js` + `run.js`):**
1. H2 registra las palabras que ya marcó (`h2FlaggedWords`); M, en vez de
   suprimir, RECLASIFICA: si la forma sin acentuar está en la letra y H2 no
   la cubrió, reporta el typo él mismo con el prefijo patcheable
   `Eñe/tilde perdida` + `patchableIssues` con sección/línea exactas.
2. `applyDeterministicAccentFixes` acepta `{ firstNames }` y corrige
   nombres estándar sin tilde vía la ortografía canónica de la lista curada
   ("Jesus"->"Jesús") — señal MÁS fuerte que el diccionario. Solo toca
   ocurrencias CAPITALIZADAS: un token minúscula idéntico a un nombre puede
   ser palabra común real (destinatario "Tomás" + "cuando tomas mi mano").

**En la misma revisión, mismos archivos (todo verificado con casos en vivo
antes de cambiar nada):**
- `ENYE_TYPOS_BLOCKLIST` partido en 2 niveles: el corrector determinístico
  convertía "El Papa nos bendijo" en "El Papá" y "yo sueno como campana" en
  "yo sueño" (el blocklist se diseñó cuando el costo de un falso positivo
  era "Haiku revisa la línea", no "reemplazo ciego"). `papa`/`sueno` ahora
  se marcan pero solo Haiku (con contexto) los corrige.
- `applyDeterministicLineFixes` (nuevo orquestador): además de tildes,
  arregla sin LLM la puntuación prohibida (—;: -> coma) y dígitos->palabras
  para los números sin problema de género/apócope (1-199 y años 1900-2099;
  los terminados en 1 y los 200+ quedan para Haiku: "veintiún años" /
  "doscientas rosas" necesitan contexto).
- El loop de generación ahora guarda el MEJOR candidato de los 3 intentos
  (menos fallos; desempate: solo-patcheables), no el último — en el bug
  original el intento 2 estaba más cerca que el 3 y se descartaba.
- El parche de Haiku exitoso ahora pasa por `runGrammarGate` igual que el
  camino valid normal (antes se salteaba LanguageTool por completo), y si
  el parche no queda limpio se le aplica una pasada determinística extra.
- El Guardia: pasada 1 ciega + pasada 2 INFORMADA con los fallos del QA
  duro (antes eran idénticas = solo ruido de sampleo), desempate con 3ra
  pasada si discrepan (mayoría decide — un veredicto ruidoso a las 3 AM ya
  no abandona una canción buena vía el timeout de 20 min), reintento con
  fallback a qwen3:8b si una pasada falla, `keep_alive: '5m'` entre pasadas
  consecutivas (antes cada pasada recargaba el 14b desde frío — minutos
  perdidos por pasada), fallos registrados SIEMPRE en
  `guardia-feedback.jsonl` (una Ollama muerta tras un reinicio ya no
  desaparece en silencio semanas) + ntfy si ninguna pasada estuvo
  disponible, campo `confianza` 1-10 y `raw` para calibración.
- `passedQA=false` con fallos de CONTENIDO ahora PAUSA antes de Suno
  (la aprobación del Guardia no anula al validador duro — una letra con
  advertencia yendo sola a Suno era exactamente el agujero del caso
  original). "LanguageTool no disponible" (red, no contenido) NO pausa.
- Guardia de audio: corre SIEMPRE (antes solo con alarma Levenshtein/NISQA)
  — un Levenshtein 90% es compatible con el nombre mal cantado, y gateado
  por alarma nunca junta verdaderos negativos para calibrar. Nuevo campo
  `nombreCorrecto` (chequeo semántico específico del nombre del
  destinatario en la transcripción, el error más caro del negocio).

**Verificación:** `npm test` (251 casos, 14 nuevos) + smoke end-to-end
offline del camino completo ("Jesus" detectado patcheable -> fixer
determinístico -> revalidación limpia, incluyendo dígitos y em dash en la
misma letra). La lección de fondo: **cada vez que un fix diga "el chequeo X
ya lo cubre", correr el caso contra el chequeo X de verdad** — acá la
suposición era falsa para el 72% de la lista.

## Tres mejoras del Guardia que quedaron pendientes de la revisión del 2026-07-13: problemas estructurados, fusión de señales de audio, estiloSuno vs encuesta

Seguimiento de las dos entradas anteriores del mismo día. En esa revisión se
identificaron 3 mejoras de menor prioridad que se dejaron sin implementar a
propósito para no engordar el cambio — esta entrada las cierra.

**1. `problemas` estructurado (antes strings libres).** El Guardia de letra
devolvía `problemas: string[]` (ej. `"[Verse 2] línea 3: rima pobre"`) — para
cruzar automáticamente sus hallazgos contra los fallos de `hardValidate` o
contra el QA humano más adelante, había que re-parsear texto libre. Ahora
`problemas` es `{ seccion, linea, tipo, gravedad, detalle }[]` (`linea` usa 0
como centinela de "no aplica a una línea puntual" — no `null`, para no
introducir el primer tipo nullable en los schemas de `format` de Ollama de
este archivo). `parseGuardiaResponse` normaliza defensivamente: tipo/gravedad
fuera del enum caen a `'otro'`/`'media'`, ítems sin `detalle` se descartan, y
un string suelto (formato viejo, por si un modelo se desvía del schema) se
envuelve automáticamente. `formatGuardiaProblem(p)` en `lib/ollama-guardia.js`
es el único lugar que arma el string legible para consola/notify — `run.js`
ya no construye ese string a mano en dos sitios distintos.

**2. Fusión de señales de audio.** El Guardia de audio (`evaluarAudioGuardia`)
solo recibía Levenshtein/NISQA/CLAP/missingNames en su parámetro `señales` —
las demás señales informativas del pipeline (loudness EBU R128, género de voz
F0, palabras pegadas/cortadas, clipping, corte abrupto, MuQ-Eval, Audiobox)
vivían cada una aislada en su propio rincón de `verify-report.json`/consola,
sin que nada las cruzara entre sí ni contra el juicio semántico. Ahora
`verify-audio.js` le pasa TODAS al armar `señales`, y un campo nuevo en el
schema, `prioridadRevision` (string, obligatorio pero puede ser vacío), le
pide al Guardia una sola frase de triage: qué conviene revisar de oído
primero y por qué, cruzando lo numérico con lo semántico (ej. "el género de
voz detectado no coincide con lo esperado en el segundo 45" o "las alarmas
numéricas son probable falso positivo, el contenido real está bien"). Se
loguea en consola y viaja en `report.guardiaAudio.prioridadRevision` /
`verify-report.json` — mismo patrón que el resto de las señales informativas.

**3. `estiloSuno` vs encuesta.** Antes solo `hardValidate` (chequeo J) validaba
que `estiloSuno` incluyera "seseo" — nadie juzgaba si el estilo EN SÍ (género,
instrumentación, energía) tenía sentido para la ocasión de la encuesta (un
"reggaetón, upbeat" para un funeral, por ejemplo). `buildGuardiaPrompt` ahora
recibe `estiloSuno` y lo muestra en su propia sección; el schema tiene un
campo nuevo `estiloCoincide: boolean`, y si hay desajuste el Guardia lo
reporta también dentro de `problemas` con `tipo: 'estilo'`. Es puramente
advisory — no gatea por separado, entra al veredicto general de `aprobada`
del Guardia como el resto de sus criterios (ya existente).

**Verificación:** `npm test` (258 casos, 7 nuevos) + smoke offline en proceso
(sin llamar a Ollama real, había un `--loop` corriendo en modo poll al hacer
este cambio) de los 3 caminos: prompt de letra con estilo+problemas
estructurados, prompt de audio con señales de fusión, parseo de ambas
respuestas. No se validó en vivo contra Ollama todavía — el próximo REDO o
canción real confirma que qwen3 respeta el schema ampliado (más campos
obligatorios en `format` = más superficie para que el modelo se desvíe;
`parseGuardiaResponse`/`parseAudioGuardiaResponse` ya degradan con gracia si
así fuera, pero conviene revisar el primer `guardia-feedback.jsonl` real tras
este cambio).

## Antigravity reemplazó LanguageTool por Ollama y se revirtió — ya existía un mandato explícito de "que eso NUNCA FALLE" (2026-07-13)

Antigravity propuso y llegó a commitear (`cc1a46c`) borrar `lib/languagetool-check.js`
por completo y reemplazar la Capa 2 de QA ortográfico/gramatical por un prompt
a Ollama (`lib/ollama-corrector.js`), motivado por el bug real de "Jenner"
(ver entrada de arriba). Problema: ese bug de "Jenner" ya se había arreglado
ESE MISMO DÍA con un fix chico y determinístico (`extractSurveyProperNouns`
sumado a `excludeWords` en `runGrammarGate`) — la motivación citada para el
reemplazo ya no existía. El cambio se hizo sin revisar esta misma sección de
LESSONS.md, que documenta por qué LanguageTool se agregó en primer lugar
(2026-07-11, "Fogata en la Arena": Hector escaló "que eso NUNCA FALLE" y puso
en riesgo su posición en la empresa por este tipo de error — no es un
requisito cualquiera).

**Por qué el reemplazo era riesgoso, más allá de la motivación ya resuelta:**
1. `optimizeLyricsPhonetics` no tenía NINGÚN chequeo de que Ollama solo tocara
   tildes/eñes/puntuación — solo corría `hardValidate` (estructural), que es
   exactamente el chequeo que NO detectó "Jenner"→"tener" la primera vez
   (grammaticalmente válido, solo factualmente incorrecto). Mismo hueco,
   tecnología distinta.
2. `test/ollama-corrector.test.js` no era un test real: sin `describe`/`it`,
   llamaba a Ollama en vivo sin mock. Corrido bajo `node --test` (el mismo
   comando de `npm test`) colgaba ~95s y FALLABA. La suite completa nunca
   pasó en verde con este cambio adentro — el "253 pasados, 0 fallos"
   reportado era de una corrida anterior a que este archivo existiera.
3. El borrado de `lib/languagetool-check.js` ni siquiera quedó commiteado
   (quedó como `D` sin commit en el working tree) pese a que el mensaje del
   commit decía "se elimina languagetool-check.js".

**Fix real:** revertido por completo. `run.js` vuelve a usar `runGrammarGate`
(LanguageTool) como Capa 2, byte-idéntico a la versión previa a `cc1a46c`
(confirmado con `git diff <commit-anterior> -- run.js` vacío). `lib/ollama-corrector.js`
se conserva como módulo opcional NO wireado en el pipeline, con un guardarraíl
nuevo (`onlyAccentsChanged`) que compara palabra por palabra ignorando
tildes/mayúsculas y RECHAZA cualquier corrección de Ollama que cambie una
palabra real — mismo patrón que ya usa `applyDeterministicAccentFixes` para
no autocorregir homógrafos ambiguros a ciegas. Su test se reescribió 100%
offline (`fetchImpl` inyectable, mismo patrón que `ollama-guardia.test.js`),
incluyendo el caso exacto "Jenner"→"tener" como regresión.

**Takeaway para cualquier agente (Claude Code, Antigravity, el que sea):**
antes de proponer reemplazar una pieza de infraestructura que existe por una
razón histórica, buscar esa razón en LESSONS.md primero — "esto es frágil"
no es motivo suficiente si la fragilidad específica que motivó el cambio ya
se resolvió con un fix más chico y focalizado en otro lado.

## "Miami": un lugar inventado pasó TODAS las capas de QA — la fidelidad del Guardia no detecta hechos inventados, ni con el prompt endurecido (2026-07-14, "El Hombre De Mi Vida")

La letra generada decía "un mismo destino nos cruzó por Miami" y fusionaba
dos capítulos de vida separados (encuentro adolescente sin relación → vidas
separadas → matrimonios previos → reencuentro un 13 de mayo) en una sola
historia de amor continua desde la adolescencia. La encuesta jamás menciona
Miami (solo Cuba y Estados Unidos) y dice explícitamente "nunca imaginé tener
una relación con él" del primer encuentro y que ambos venían de matrimonios
previos. Lo detectó HECTOR leyendo la letra — ninguna capa automática:

- `hardValidate`: nada chequeaba hechos, solo estructura/ortografía/trato.
- El Guardia (qwen3:14b): **fidelidad=10, aprobada=true en la pasada ciega Y
  en la informada**. Y lo más importante: tras endurecer el prompt pidiendo
  chequeo HECHO-POR-HECHO (listar lugares/fechas/secuencia temporal y
  verificar cada uno contra la encuesta, con instrucción explícita de
  puntuar 1-4 ante un solo hecho no respaldado), se re-testeó EN VIVO contra
  la misma letra mala: **fidelidad=10, aprobada=true, cero problemas, 83s**.
  El juicio de "fidelidad" del modelo verifica que los TEMAS de la encuesta
  aparezcan en la letra (Cuba ✓, 13 de mayo ✓, nietos ✓), no que cada
  afirmación de la letra esté respaldada por la encuesta — la dirección
  inversa, que es donde viven las alucinaciones.

**Fix real (mismo principio que "más de vos" y el chequeo M: lo duro vive en
código, no en un prompt):**
1. Chequeo N nuevo en `hardValidate` (`findInventedProperNouns`,
   lib/song-validate.js): en español, un token Capitalizado en MEDIO de una
   línea es un nombre propio; si no está en la encuesta, ni es término
   religioso (regla 8 permite a Dios sin encuesta), ni respelling fonético
   del destinatario (levenshtein ≤ len/2 con foneticaAplicada, o
   name-dictionary.json), el modelo lo inventó. NO parcheable: regen con
   contexto; si persiste 3 intentos, la pausa pre-Suno existente. Verificado
   contra los datos reales del día: marca "Miami" en la letra mala (sección
   y línea exactas), cero falsos positivos en la letra buena, en los 278
   casos de npm test y en el mock del dry-run.
2. El prompt del GENERADOR (run.js regla 2) sí se endureció con éxito:
   lugares/fechas/fusión de capítulos listados explícitamente como
   invención prohibida. La letra regenerada preservó los dos capítulos
   reales ("Volviste separado y yo también volví") y eliminó Miami —
   verificado leyendo la letra Y contra la transcripción Whisper del audio
   final que se entregó.
3. El prompt del Guardia quedó endurecido igual (no hace daño y deja rastro
   del criterio), pero **documentado acá que NO es una garantía**: la
   fusión de línea de tiempo (distorsión de hechos SIN nombres propios
   nuevos) sigue sin cobertura determinística — hoy la atrapan solo el
   prompt del generador mejorado y el QA humano.

**Trampa de caché descubierta en el mismo incidente:** para regenerar la
letra mala se borró `state.json` (el mecanismo documentado para un redo desde
cero)... y `run.js` sirvió LA MISMA letra mala desde `.cache/<hash>.json` —
la caché se indexa por hash de la ENCUESTA, que no cambió. Borrar state.json
solo resetea el pipeline, no el contenido. Fix: flag `--force-regen` en
run.js (start-flow.js lo reenvía) que saltea la lectura de caché; la letra
nueva válida se re-cachea al final como siempre.

## Suno generó ambas versiones al doble de duración con versos en loop — la alarma llegaba 6+ min tarde (2026-07-14, mismo día)

Mismo día, tras el redo: Suno generó A=5:36 y B=5:26 (esperado 2:45-3:30)
con líneas literalmente duplicadas en la transcripción y partes del
coro/bridge faltantes. El Guardia de audio SÍ lo atrapó (similitud 5-6/10,
aprobada=false en ambas — funcionó como se diseñó) y el pipeline pausó bien,
pero la señal más barata y mecánica (la duración, ffprobe <1s) recién se
reportaba después de los ~6 min de demucs+Whisper+CLAP+NISQA, con el Flow ya
llenado. Fix: `isDurationWildlyOff` (lib/audio-analysis.js, margen 1.5x
sobre el rango 2:45-3:30, compartido — nunca dos criterios distintos para lo
mismo): verify-audio.js avisa por ntfy apenas lee las duraciones, y
start-flow.js PAUSA para revisión humana apenas termina la descarga, fuera
del while de reintentos de Create (un timeout de la pausa jamás debe
re-clickear Create — decisión explícita de Hector: avisar+pausar, nunca
gastar créditos solo). En --loop la pausa expira a los 20 min y la canción
se abandona sin subir nada.

**Del mismo repaso, dos robusteces menores:** (1) upload-to-flow.js ahora
reintenta el cascade de selectores del `input[type="file"]` 3 veces
(0s/8s/15s) y guarda `flow-upload-diagnosis.png` antes del fallback manual —
el fallo real del 2026-07-13 ("La Pelota Que Se Soltó", 0 inputs en una sola
pasada) quedó sin causa raíz diagnosticable por falta de evidencia; nunca
`page.reload()` acá (la pestaña tiene el formulario recién llenado y no está
verificado que persista). (2) El ticker `[Countdown]` de la espera del
Submit solo escribe con TTY real: con stdout a un archivo (`--loop > log`)
el `\r` no sobreescribe y cada tick se apilaba — cientos de repeticiones por
línea inflando los logs de la noche.

## Extracción cerrada de hechos: el LLM lista, el código juzga — el reemplazo del juicio de fidelidad que sí funciona (2026-07-14, mismo día, seguimiento del caso "Miami")

Seguimiento inmediato de la entrada de "Miami": si pedirle al Guardia que
JUZGUE fidelidad no detecta hechos inventados (fidelidad=10 verificado en
vivo, dos veces, con y sin prompt endurecido), la salida no es un mejor
prompt de juicio — es cambiar la tarea. Extraer es mucho más fácil que
juzgar: `extraerHechosLetra` (lib/ollama-guardia.js) le pide al mismo
qwen3:14b que solo LISTE lugares/personas/fechas que la letra afirma
(schema cerrado, sin opinar), y `compararHechosConEncuesta` decide EN
CÓDIGO si cada hecho está respaldado por la encuesta (tokens normalizados,
dígitos expandidos a palabras — "13 de mayo" respalda "trece de mayo" —,
whitelist religiosa de la regla 8, respellings).

Verificado en vivo el mismo día contra las dos letras reales del caso:
- Letra MALA: extracción lista "Miami" como lugar en 28s (el juicio de
  fidelidad tardaba 83s en NO verlo) → comparación lo marca sin respaldo.
- Letra BUENA: extracción limpia, CERO falsos positivos — la propiedad que
  importa para graduarlo a gate.
- Ruido observado: sobre la letra mala qwen3 a veces sobre-extrae frases
  poéticas como "momentos" ("un mismo destino", "la isla") que se marcan de
  más — aceptable, cae del lado seguro (la letra YA es mala); el prompt
  excluye explícitamente frases abstractas y aún así puede colarse alguna.

INFORMATIVO por ahora (protocolo estándar Capa 3): consola + state.json +
guardia-feedback.jsonl con `extraccionHechos`/`hechosSinRespaldo` en cada
canción. **Criterio de graduación a gate (camino al 100% automático):**
cuando el jsonl acumule un puñado de canciones reales con extracción limpia
en letras buenas (sin falsos positivos), `hechosSinRespaldo` puede pasar a
disparar el MISMO regen automático que el chequeo N — cero pausas nuevas.
La lección general: **cuando un LLM falla juzgando, no le pidas mejor
juicio — pedile datos y juzgá en código.**

## think:true tampoco arregla el juicio de fidelidad + nace el banco dorado, que atrapó su primer falso positivo el mismo día (2026-07-14, cierre del caso "Miami")

Dos cierres del mismo día:

**1. La pregunta abierta de `think: false` quedó respondida.** El comentario
de lib/ollama-guardia.js decía "verificar efecto en vivo". Se corrió el
juicio de fidelidad con `think: true` (razonamiento completo de qwen3:14b,
145s) sobre la letra mala de "Miami", mismo prompt endurecido: **fidelidad=10,
aprobada=true, confianza=10**, y el veredicto hasta afirmó "sin inventar ni
alterar la cronología". El razonamiento visible muestra al modelo comparando
TEMAS (¿Cuba está? ¿el 13 de mayo está?) en vez de verificar afirmaciones.
Conclusión definitiva: no era la config ni el prompt — JUZGAR fidelidad está
fuera del alcance de este modelo. No gastar más esfuerzo en prompts de
juicio; la arquitectura correcta es extraer + juzgar en código (entrada
anterior).

**2. `guardia-benchmark.js` + `golden/`** — el testeo manual contra letras
reales que se hizo dos veces a mano hoy, convertido en herramienta: cada
incidente real agrega una carpeta a `golden/` (song.txt + survey.txt +
expect.json) y cualquier cambio de prompt/modelo se mide con
`node guardia-benchmark.js` (costo cero — todo Ollama local). En su PRIMERA
corrida completa ya pagó: atrapó que la extracción marcaba "la casa" como
hecho sin respaldo en la letra BUENA (la encuesta decía "hogar") — falso
positivo que dos verificaciones manuales previas no habían visto (varianza
de sampleo de qwen3). Fix calibrado: hechos en minúscula solo se marcan si
contienen un dato temporal/numérico sin respaldo; sustantivos comunes son
escenografía poética que la regla 2 permite. Tras el fix, banco completo en
verde con precisión mejor que antes (la letra mala marca exactamente
"Miami", sin ruido). La lección: **la propiedad "cero falsos positivos en
letras buenas" — la que decide si una señal puede graduarse a gate — solo se
puede afirmar con un banco de casos reales, nunca con 1-2 corridas manuales.**

## Bug: Reproductor del Flow muestra el doble de duraci�n que Suno (2026-07-14)

**S�ntoma:** Una canci�n bajada de Suno que dura 3:17 (confirmado en la UI de Suno y al reproducirla hasta el final) marcaba 7:16 en el reproductor del Flow (y en fprobe).
**Diagn�stico:** Suno exporta los MP3 usando VBR (Variable Bitrate) pero omite inyectar la cabecera Xing/Info necesaria. Los reproductores (como el del Flow y fprobe r�pido) estiman la duraci�n usando el bitrate del primer frame (que al ser silencio es muy bajo, ej. 81 kbps) multiplicado por el tama�o total del archivo (4.3 MB). Matem�tica pura: asume que todo el archivo es a 81 kbps y da 7 minutos, cuando en realidad el estribillo sube a 192 kbps y la canci�n real termina a los 3:17.
**Fix:** En lib/suno-create-dl.js, justo despu�s de descargar el MP3, se lo pasa por fmpeg -c copy que recrea el archivo inyectando la cabecera correcta. Ahora todos los MP3 subidos al Flow marcan su duraci�n real perfecta.

## Migración de El Guardia de Ollama a Claude Haiku (Antigravity, 2026-07-14): rota desde el día 1 por dos incompatibilidades de schema — solo se descubrió probando en vivo

Antigravity (otro agente) migró `lib/ollama-guardia.js` de Ollama local
(gratis) a la API de Claude Haiku, y agregó un "reprompt" nuevo en `run.js`
que usa `lib/song-corrector.js` para auto-parchar problemas que el Guardia
encuentra. Revisado antes de aceptarlo (no se aplicó a ciegas):

**Lo que se aceptó tal cual:** el fix de duración (`lib/suno-create-dl.js`,
re-empaqueta el MP3 con `ffmpeg -c copy` para inyectar la cabecera VBR que
Suno no incluye) — chico, seguro, sin costo, causa raíz plausible del "bug
de los 7 minutos" del mismo día.

**Lo que NO se aceptó a ciegas — 4 problemas reales encontrados antes de
confiar en la migración:**

1. **Costo:** el Guardia pasó de "local y gratis, corré siempre" a gastar
   créditos reales de `ANTHROPIC_API_KEY` en cada canción, cada pasada (2-3
   de letra + extracción de hechos + audio ×2 + el reprompt). Documentado
   explícitamente en el header del archivo — no es gratis nunca más.
2. **6 tests rotos:** los tests existentes mockeaban el shape de respuesta
   de Ollama (`{message:{content}}`); el código real ahora espera el shape
   de Anthropic (`{content:[{type:'text',text}]}`). `npm test` nunca se
   corrió después de la migración — se habría visto de inmediato.
3. **`--dry-run` dejó de ser gratis:** el bloque del Guardia corría SIEMPRE,
   sin importar `isDryRun` (tenía sentido cuando Ollama era gratis). Con
   Haiku, cada `--dry-run` gastaba créditos reales en silencio, rompiendo la
   garantía documentada "cero API, cero gasto". Fix: todo el bloque ahora
   se saltea si `isDryRun`.
4. **El reprompt de Haiku podía tapar un problema de fidelidad real:**
   `lib/song-corrector.js` se amplió de "solo errores mecánicos puntuales" a
   "mecánicos, poéticos O DE CONTENIDO", y si el parche pasaba `hardValidate`
   (solo estructura), el código levantaba el rechazo del Guardia SIN volver a
   correr la extracción de hechos sobre el texto parcheado — exactamente el
   tipo de agujero que el caso "Miami" (entrada anterior) enseñó a cerrar.
   Fix: si el problema reprompteado era de tipo `fidelidad`, ahora se
   re-corre `extraerHechosLetra` + `compararHechosConEncuesta` sobre el
   parche antes de levantar el veto — si sigue habiendo un hecho sin
   respaldo, el parche se descarta y el rechazo original queda en pie.

**El hallazgo más grave — 2 bugs de schema que rompían el Guardia al 100%,
en SILENCIO, desde el primer commit de la migración:** probar en vivo contra
`ANTHROPIC_API_KEY` real (pedido explícito de Hector: "quiero probar el
haiku... a ver que tal va") reveló que **ninguna llamada al Guardia había
funcionado nunca** — `validarGuardia` siempre devolvía `ok:false` (por
diseño, "nunca lanza"), así que el pipeline corría sin ninguna señal del
Guardia sin que apareciera ningún error visible:
- `output_config.format` de Anthropic exige `additionalProperties: false`
  explícito en todo objeto del schema — Ollama nunca lo exigía. Sin esto:
  `400 additionalProperties must be explicitly set to false`.
- Anthropic RECHAZA `minimum`/`maximum` en propiedades `integer` del schema
  — Ollama los toleraba sin problema. Sin sacarlos: `400 properties maximum,
  minimum are not supported`. El clamp a 1-10 se mantiene igual, pero ahora
  vive solo en `parseGuardiaResponse` (código), no en el schema.

Ambos bugs se arreglaron y se re-verificaron EN VIVO (no solo con
`fetchImpl` mockeado): `validarGuardia` y `extraerHechosLetra` corridos
contra la API real dieron veredictos sensatos y bien calibrados (detectó
una omisión real: la encuesta mencionaba "Starbucks", la letra generalizaba
a "una taza de café" — severidad baja, correcto).

**Takeaway repetido de esta sesión:** un mock offline (`fetchImpl`
inyectable) prueba que el CÓDIGO maneja bien una respuesta dada — nunca
prueba que la LLAMADA REAL a la API sea válida. Los 2 bugs de schema
pasaban los 291 tests offline sin ningún problema porque los mocks nunca
validan el schema contra las reglas reales de la API. Antes de confiar en
cualquier integración nueva con una API externa, correr AL MENOS una
llamada real de punta a punta — es la única forma de atrapar esta clase de
bug, y salió barato (unos centavos, un puñado de llamadas a Haiku) comparado
con haberlo descubierto recién a la noche, con el loop corriendo solo y sin
nadie mirando.

## Auditoría de idempotencia: intents write-ahead en state.json — el re-click automático de Create contradecía la regla firme, y un kill entre Submit y COMPLETED podía doble-submitear (2026-07-14)

Auditoría a fondo de las 3 acciones irreversibles del pipeline (Create de
Suno = créditos reales, upload al Flow, Submit to QA) contra reinicios del
watchdog (`taskkill /F` + relanzamiento con `--loop --resume`) y doble-runs.
Tres agujeros reales encontrados y cerrados:

**1. El retry-loop de Create RE-CLICKEABA Create automáticamente.** El
`while` de `MAX_CREATE_RETRIES` en start-flow.js decía literalmente
"re-clickeando Create sobre el mismo formulario (gasta créditos de nuevo)" —
contradiciendo la regla firme de Hector (2026-07-14, caso duración anómala:
"avisar+pausar, NUNCA re-clickear Create solo"). Fix: **intents
write-ahead** — `lib/suno-create-dl.js` registra en state.json
`intents.create.clickedAt` ANTES del click físico y `downloadedAt` al
confirmar el primer MP3 en disco. La decisión de reintento es ahora
`decideCreateRetry` (pura, testeada con un test que recorre attempts 1-10 y
exige que con clickedAt presente JAMÁS salga 'retry-create'): fallo
pre-click → re-Create seguro; fallo post-click → SOLO se reintenta la
descarga con `downloadOnly()` (nueva: busca las 2 cards más recientes del
título en la UI de Suno, espera la generación si hace falta y descarga con
el mecanismo compartido `downloadReadyCards`). Conservador a propósito: un
clickedAt registrado con un click que en realidad no prendió cuesta una
confirmación humana, nunca créditos dobles en silencio.

**2. Kill entre el click de Submit y la escritura de COMPLETED → --resume
re-subía y RE-SUBMITEABA.** La etapa quedaba en `flow-filled` y el resume
clásico re-llenaba el Flow (peor aún: si el Flow ya había asignado OTRA
canción, `enterFlowAndEnsureAssignment` la cargaba y flow-submit llenaba la
asignación nueva con los datos de la canción vieja). Fix:
`intents.submit.clickedAt` se escribe ANTES de `submitBtn.click()` y
`confirmedAt` tras el modal; `interpretResume` (pura, 10 tests) detecta el
caso y `resumeAfterSubmitIntent` verifica en "Recent completions" antes de
tocar NADA: card visible → solo cierre (runDone); confirmado sin card →
runDone(null) (mismo camino que --done); ambiguo → ntfy urgente + no tocar
nada, decide un humano. El Auto-Submit además consulta `shouldAutoSubmit`
(lib/flow-helpers.js, pura): un intent de submit ya clickeado para la misma
canción bloquea el click aunque el timer y el upload estén verdes.

**3. `uploadConfirmed` se infería del exit code.** Un ENTER humano en la
pausa de upload-to-flow.js "para destrabar" (sin subir nada) daba exit 0 y
start-flow marcaba la subida como confirmada → el Auto-Submit podía mandar
a QA una subida inexistente (en un REDO, la versión VIEJA). Fix:
upload-to-flow.js registra `intents.upload.verifiedAt` SOLO tras ver el
archivo en el DOM del Flow (y re-verifica tras el ENTER manual);
start-flow.js exige ese intent con el songId correcto. Además
`downloads: {A: {path, sha256, bytes}, B}` en state.json (escrito por
downloadReadyCards al descargar): upload-to-flow.js sube el archivo EXACTO
registrado (verificando sha256) y la búsqueda legacy por título+recencia
(que podía agarrar un MP3 viejo o de otra canción con título parecido en la
ventana de 60-180 min) quedó como fallback con advertencia fuerte.

**Herramientas nuevas:** `node start-flow.js --explain-resume` (solo lee
state.json, imprime la decisión de interpretResume y sale — cero browser,
cero red, corre ANTES del flush de galería a propósito) para inspeccionar
un estado dudoso. `startNew()` limpia los intents (canción nueva = pizarra
limpia; sin esto, un downloadedAt viejo de la canción anterior enmascaraba
un create-clicked-no-download de la actual — bug atrapado en diseño, antes
de escribir el código).

**Preflight ampliado (idea de IDEAS.md, cableada):** `checkCdpPort`
distingue "Chrome debug listo" / "puerto libre" / "ocupado por algo que NO
responde como Chrome debug" (este último era el fallo confuso a mitad de
flujo); `checkLanguageTool` avisa como warning si la Capa 2 va a degradar
(antes se apagaba en silencio); y un preflight fallido ahora NOTIFICA por
ntfy urgente (antes solo consola — en --loop desatendido reintentaba toda
la noche sin que llegara ningún push). `runPreflight` pasó a ser async.

## Canal de respuestas remoto por ntfy: las pausas ahora se resuelven desde el celular — validado en vivo contra la API real antes de confiar (2026-07-14)

Hasta hoy ntfy era estrictamente SALIENTE: toda pausa (`pauseForHumanInteraction`
/ `confirmToContinue`) solo se resolvía con un ENTER físico en la terminal, y
en `--loop` el timeout de 20 min abandonaba la canción aunque Hector hubiera
visto la notificación en el celular a los 30 segundos. Cerrado con el **reply
channel** (lib/ntfy.js):

- **Tópico de respuestas separado** (`REPLY_TOPIC`, sufijo aleatorio propio) —
  separado del principal a propósito: publicar la respuesta en el mismo tópico
  generaría una notificación-eco por cada botón tocado.
- **Botones en la notificación** (campo `actions` de la API JSON de ntfy,
  action `http`): cada botón postea `<requestId>:<ok|abort>` al tópico de
  respuestas directo desde la app — sin abrir nada.
- **`waitForNtfyReply`**: poll corto cada 15s (`?poll=1&since=`) — más robusto
  en Windows/red doméstica que un long-poll abierto 20 min. Nunca lanza.
- **Seguridad**: tópico impredecible + nonce por pausa (`requestId`, 4 bytes) +
  `since` acotado — un replay viejo o un mensaje ajeno no matchea nada
  (`parseReply` es puro y testeado). Si algún día hace falta más, el formato
  admite un HMAC como tercer campo sin romper el parser.
- **Integración**: `waitForHumanResponse` corre `Promise.race` entre el ENTER
  local y el poll remoto, con cleanup garantizado del perdedor (el listener de
  stdin mantiene vivo el event loop — dejarlo colgado tras un reply remoto era
  un leak real en diseño). `ok` remoto = ENTER; `abort` remoto = nueva
  `HumanAbortError`, que **extiende HumanTimeoutError A PROPÓSITO**: todos los
  catch existentes del repo ya tratan eso como "abandonar esta canción y
  seguir" — cero callers tocados.
- **Screenshots adjuntos** (`notifyAttachment`, PUT binario + header
  `Filename` ASCII puro — mismo bug de ByteString/emoji ya documentado): el
  checkpoint pre-Create manda suno-verify-overview/lyrics-top.png y las pausas
  de upload mandan flow-upload-verify/diagnosis.png — se decide desde el
  celular mirando la evidencia.
- **Re-Create con aprobación explícita**: la rama give-up del retry de Create
  ahora ofrece botones (🔁 solo descarga si Create ya prendió / ✅ re-Create
  con gasto de créditos si no) — la ÚNICA forma de re-clickear Create, jamás
  automática. Timeout → comportamiento de siempre (seguir sin subir, gate
  bloquea el submit).

**Validación en vivo (protocolo del caso Haiku del mismo día):** antes de
confiar, se corrió el ciclo completo contra la API REAL de ntfy con tópicos
descartables: POST con `actions` (200), POST del reply simulando el botón
(200), `waitForNtfyReply` real lo levantó y parseó (`ok`), y el PUT de
attachment devolvió el objeto attachment correcto. Los mocks offline de
npm test NO prueban nada de esto.

**Más señales para la noche desatendida (mismo día):** preflight fallido,
watchdog que no arrancó (chequeo diferido a los 10s — la ausencia de avisos
era indistinguible de "todo bien"), y LanguageTool caído ahora notifican.
El digest de las 7am suma canciones completadas y ciclos fallidos
(`logs/pipeline-summary.jsonl` — antes una canción que fallaba en la
generación no aparecía en el resumen). Techos de heartbeat corregidos:
`sesion-suno` 10→25 min (violaba la regla de convivencia con el timeout
humano de 20 min) y `esperando-submit` 24h→10 min de ticker (con 24h, un
loop de espera colgado dejaba al watchdog ciego un día entero; ahora el
único pulso sostenido es el del loop real, y gracias a los intents de
submit el relanzamiento del watchdog en esa etapa es seguro).

## FACT_GATE: el camino medible de la extracción de hechos a gate automático + smoke de API real al arrancar el loop (2026-07-14)

Continuación directa del caso "Miami" y su lección ("cuando un LLM falla
juzgando, pedile datos y juzgá en código"). La extracción cerrada de hechos ya
funcionaba como señal informativa — ahora tiene el camino COMPLETO a gate, con
criterio medible en vez de "cuando se sienta listo":

- **`FACT_GATE=off|warn|regen`** (default `warn` = comportamiento histórico).
  Con `regen`, el gate corre DENTRO de `generateSongWithSelfCorrection`
  (run.js), sobre la letra que ya pasó hardValidate + LanguageTool y justo
  antes de devolverla como buena: extrae hechos (Haiku) + compara EN CÓDIGO
  contra la encuesta; un hecho sin respaldo dispara el mismo regen correctivo
  que el chequeo N, dentro del presupuesto de 3 intentos. La decisión es
  `decideFactGateAction` (lib/ollama-guardia.js, pura, 7 tests): señal caída
  JAMÁS bloquea, modo desconocido cae a warn (fail-safe), y tras 2 regens de
  hechos en la misma canción degrada a warn (un gate mal calibrado a las 3 AM
  no quema la cola). El mismo gate corre sobre el resultado del corrector
  barato (que puede reescribir líneas enteras) — misma letra, misma vara.
  Kill-switch: FACT_GATE=warn.
- **Calibración con botones en el celular**: cuando la señal informativa marca
  "HECHO SIN RESPALDO", run.js manda ntfy con botones 🚨 Bien detectado /
  ❌ Falso positivo que postean `fact:<songId>:<tp|fp>` al reply topic. Como
  run.js es efímero, los veredictos los junta el WATCHDOG (vive toda la
  noche) en cada tick → `logs/fact-verdicts.jsonl`.
- **`node guardia-benchmark.js --readiness`**: imprime READY/NOT READY con el
  criterio completo — banco dorado ≥10 casos (≥4 malas/≥5 buenas), ≥15
  canciones reales con extracción en guardia-feedback.jsonl, 0 veredictos FP,
  y 0 alarmas sin juzgar (una alarma sin veredicto humano NO cuenta como
  limpia). Hoy: NOT READY (2 casos dorados, 2 canciones, 2 alarmas sin
  juzgar) — el modo warn + los botones van juntando la evidencia solos.
  **Pendiente de datos reales:** ampliar golden/ exige letras reales de
  incidentes/QA aprobado — no se pueden inventar casos sintéticos sin
  violar la lección del banco ("solo casos reales").

**Robustez del proveedor (misma tanda):** el fetch del generador en
lib/llm-provider.js ahora lleva `AbortSignal.timeout(120000)` — sin signal,
un socket colgado de la API trababa la corrida hasta el techo de etapa de
25 min + kill del watchdog. Y `node lib/preflight.js --with-api` corre UNA
llamada real mínima a Haiku (fracción de centavo): `--loop` la ejecuta al
arrancar y NO arranca si falla (push urgente) — key vencida/sin saldo se
descubre a las 22:00, no a las 3 AM. Verificado en vivo (exit 0, Haiku
respondió; y el clásico crash de libuv por process.exit en el mismo tick
que el cierre del socket se evitó con el patrón exitAfterDelay de siempre).

**Decisión documentada — prompt caching del Guardia: NO por ahora.** El
prompt del Guardia pone el contenido dinámico (encuesta/letra) ANTES de las
instrucciones estáticas; cachear exigiría reestructurarlo (instrucciones →
system con cache_control), y un cambio de estructura de prompt en un
componente que gatea exige recalibrar contra el banco dorado. Ahorro
estimado: centavos/día (Haiku). Riesgo/beneficio no cierra hoy; si el banco
crece a ≥10 casos, rehacerlo midiendo antes/después. `estiloCoincide` ya lo
juzga el propio Guardia (campo del schema) — no hace falta un juez aparte.

## Higiene automatizada: drift check diario de selectores, npm test como gate del loop, e inventario de idempotencia como test (2026-07-14, cierre del plan de mejora)

Tres piezas de "nunca fallar en silencio" que cierran el plan del día:

1. **Drift check diario automático** (idea de IDEAS.md, pendiente desde
   2026-07-03): el watchdog corre `suno-selector-drift.js` una vez por día
   (6 AM, antes del digest) — SOLO con el pipeline ocioso (stage=completed o
   sin state), porque el script navega/recarga suno.com/create y hacerlo con
   una canción en vuelo podría pisar el formulario recién llenado
   (`shouldRunDriftCheck`, pura, testeada). Exit codes: 0 limpio · 2 drift
   (push high + línea en el digest) · 1 no se pudo correr (Chrome apagado —
   solo log, sin spam). Los ítems del menú ⋯ (Download/MP3) no cuentan como
   drift: el script es de solo lectura y Radix no los renderiza sin abrir el
   menú.
2. **npm test como gate de `--loop`**: la suite es offline y tarda ~3s;
   correrla al arrancar el loop atrapa un edit roto del día (la migración a
   Haiku dejó 6 tests rotos sin que nadie corriera la suite) ANTES de dejar
   la noche sola. Falla → el loop no arranca + push urgente. Detrás corre el
   smoke de API real (entrada anterior).
3. **`test/idempotency-inventory.test.js`**: el inventario COMPLETO de
   acciones irreversibles (Create, retry de Create, Submit, upload, notas,
   hoja, galería) con sus guards como test-tabla — chequeos textuales que
   rompen con nombre y apellido si un refactor borra un guard, más dos
   chequeos de ORDEN (el intent write-ahead debe escribirse ANTES del click,
   o pierde su razón de ser). No prueban comportamiento (eso lo hacen los
   tests de las funciones puras) — prueban que la pieza no desapareció.

## Sangrado del Golden Example en producción la misma noche — y el gate determinístico que lo generaliza (2026-07-15)

El Golden Example (encuesta real → letra real aprobada) entró al SYSTEM_PROMPT
y en la SEGUNDA canción generada ("Keyla") el Bridge abrió con "cuando ya no
esté para decirlo de frente" — casi calco del Bridge del ejemplo ("Cuando ya
no esté para decirlo con mi voz"). El riesgo conocido del few-shot, confirmado
en horas: el ejemplo pesa más que las reglas, para bien (la rima subió de 3/12
pares a 6/12 en esa misma canción) y para mal (copia).

**Fix en dos capas (pedido de Hector: "generalizado", sin tocar la canción en
vuelo):**
1. Prompt: la advertencia anti-copia del ejemplo nombra el caso visto y exige
   reescribir cualquier frase reconocible. NO es la garantía.
2. La garantía: `lib/example-bleed.js` (`findExampleBleed`, puro/offline/cero
   LLM) compara cada línea generada contra las líneas del ejemplo — calco si
   comparten un n-grama de 5+ palabras que la ENCUESTA no contiene (si el
   cliente lo dijo, es material legítimo — exención clave para frases tipo
   "le doy gracias a dios por"), o si la similitud Jaccard de la línea es
   ≥80% (mismas palabras, otro orden). Cableado en
   `generateSongWithSelfCorrection` como gate correctivo desde el día 1 (por
   ser determinístico y gratis no necesita fase informativa): un calco
   dispara el mismo regen con instrucciones que el chequeo N, también sobre
   el resultado del corrector barato (misma letra, misma vara). Fuente
   canónica de las líneas: golden/2026-07-14-damian-buena/song.txt — si el
   ejemplo del prompt cambia de canción, actualizar EXAMPLE_SONG_PATH. Sin
   archivo → chequeo desactivado en silencio, jamás rompe una generación.
   Verificado contra el calco real de producción (lo detecta) y contra letras
   sin relación (cero falsos positivos), + 7 tests en test/example-bleed.test.js.

## El Guardia rechazó una letra y el loop la sirvió IDÉNTICA desde caché para siempre — la caché no sabía del rechazo (2026-07-15, "El Pañuelo Azul y Blanco")

**Incidente real:** el Guardia rechazó "El Pañuelo Azul y Blanco" por mayoría
(2/3 pasadas) con un motivo de fidelidad ("fusiona dos viajes separados,
2022 y 2025, sin aclaración temporal") — la pausa humana expiró a los 20 min
(nadie respondió a tiempo) y la canción se abandonó. El siguiente ciclo del
`--loop` volvió a tomar la MISMA asignación (seguía activa en el Flow, nadie
había hecho Submit) y sirvió la letra desde `.cache/` **sin volver a generar**
— exactamente el mismo texto rechazado, camino a rechazarse de nuevo. Un
humano cortó el loop con Ctrl+C antes de que terminara la segunda consulta.

**Diagnóstico:** no fue un hecho inventado — la capa de extracción determinística
(la que juzga en código) encontró las 13 afirmaciones de la letra **todas
respaldadas por la encuesta**. El problema real era una AMBIGÜEDAD: la línea
"Me dolió ver tus pies cansados en aquel camino" no aclaraba a cuál de los dos
viajes se refería (la encuesta lo ata específicamente al de 2025), y eso
confundió a las dos pasadas CIEGAS del Guardia (la pasada informada, con más
contexto, sí había aprobado). Cero invención, pero una redacción real y
evitable que el propio Guardia no podía distinguir de una fusión de capítulos.

**Root cause del "para siempre" — el bug de verdad:** `writeCache()` en run.js
se llama apenas la letra pasa hardValidate + LanguageTool + FACT_GATE +
example-bleed — TODO eso corre ANTES de consultar al Guardia. La caché
(indexada por hash de encuesta, sin metadata de resultado) no tiene forma de
saber que esa letra terminó siendo rechazada más adelante en la misma
corrida. Cualquier corrida futura sobre la misma encuesta (retry del
--loop, --resume, o simplemente correr run.js de nuevo mañana) la sirve
igual, atascando la canción en un rechazo que se repite indefinidamente sin
que nadie lo note hasta que alguien mira los logs.

**Fix (dos capas, mismo principio del repo — la garantía vive en código):**
1. `lib/cache-helpers.js`: nueva `invalidateCache(hash)` (borra el archivo,
   best-effort, nunca lanza). `run.js` la llama apenas `guardiaRechaza` queda
   confirmado en `true` (después de que el reprompt de Haiku ya tuvo su
   oportunidad de arreglarla y no lo logró) — así la PRÓXIMA corrida sobre
   esa encuesta está forzada a generar de cero, con sampleo nuevo del modelo,
   en vez de repetir el texto rechazado. 3 tests nuevos en
   `test/cache-helpers.test.js`.
2. SYSTEM_PROMPT, regla 2 (`run.js`): nueva cláusula explícita —"cuando la
   encuesta menciona dos eventos del mismo tipo (dos viajes, dos casas, dos
   enfermedades), cada detalle sensorial/emocional atado a UNO de ellos debe
   nombrar cuál es (lugar o fecha en la misma línea o la anterior), nunca un
   pronombre genérico que podría aplicar a cualquiera" — con el caso real de
   esta noche como ejemplo textual de la falla. No es una garantía dura
   (vive en el prompt, no en código), pero ataca la causa raíz de por qué el
   Guardia se confundió en primer lugar, reduciendo la tasa de este tipo de
   falso positivo en vez de solo mitigar sus consecuencias.

**Lo que NO se tocó (a propósito):** el veto del Guardia sigue teniendo poder
de bloqueo — la lección de "Miami" (juicio de fidelidad puede fallar, pero
sigue siendo la única señal contra fusiones de eventos sin hechos aislados
inventados) sigue vigente. Debilitar el gate para que este caso pasara habría
sido la solución equivocada: la letra SÍ tenía una ambigüedad real que valía
la pena arreglar, y el pedido explícito de Hector fue "arreglalo generalizado
para que nunca vuelva a pasar" — no "dejá pasar más letras". El fix ataca el
bug real (la caché ciega al rechazo) y la causa raíz de la ambigüedad
(instrucción de prompt), sin tocar el criterio de aprobación.

## Mejorando lo que hacen Haiku y Sonnet, no solo la plomería alrededor — recuperación automática de rechazos por ambigüedad (2026-07-15, seguimiento del caso "El Pañuelo Azul y Blanco")

Pedido explícito de Hector tras el fix de caché: "mejoralos lo que hace haiku
y sonnet para que esto en sí no vuelva a pasar" — no alcanzaba con arreglar
la plomería (la caché) si el patrón de fondo (el Guardia rechazando por
ambigüedad real, no invención) seguía intacto. Tres mejoras a los dos
modelos mismos, en capas de defensa creciente:

**1. El prompt del Guardia dejaba `seccion="" linea=0` como salida fácil.**
La instrucción original decía literalmente que un problema "de toda la
canción" podía ir sin ancla de línea — y el rechazo real de anoche (fusión
aparente de dos viajes) salió sin `seccion`/`linea`, así que el mecanismo
YA EXISTENTE de reprompt de Haiku (que solo arregla problemas con línea
anclada) nunca se activó, y el pipeline saltó directo a la pausa humana.
Fix: el prompt ahora exige anclar CUALQUIER problema a la línea más
representativa, reservando `seccion=""` solo para algo que de verdad no
vive en ninguna línea (ej. "el arco general es plano"). Verificado en vivo
contra la API real con el caso exacto de anoche: esta vez ancló el problema
a `[Verso 2 L2]` en vez de dejarlo suelto.

**2. El prompt de fidelidad no distinguía AMBIGÜEDAD de INVENCIÓN.** El
criterio decía "fidelidad 1-4 si hay una afirmación sin respaldo O una
fusión de capítulos" tratando ambos casos igual — pero "aquel camino" sin
nombrar el viaje no es una fusión real, es una línea que necesita nombrar el
evento. Nueva cláusula explícita: fusión/invención real = fidelidad 1-4
siempre; ambigüedad de redacción (el hecho SÍ está en la encuesta, solo
falta nombrarlo en esa línea) = fidelidad 5-6, tipo "coherencia" no
"fidelidad". Esto no debilita el veto (una fusión real sigue puntuando
bajo) — lo hace más preciso, y como consecuencia lateral las etiquetas
`tipo` quedan más útiles para lo de abajo.

**3. `shouldAttemptAmbiguityRecovery` — tercer nivel de defensa antes de
pausar** (`lib/ollama-guardia.js`, pura, 8 tests con los veredictos REALES
del incidente). Después del reprompt de línea existente (que solo parchea
líneas puntuales sin regenerar), si el Guardia sigue rechazando Y el perfil
es "ambigüedad, no invención" — extracción de hechos con CERO sin respaldo
(la señal más confiable, ver caso "Miami") + el resto de los puntajes
(coherencia/rima/tono) son buenos, solo fidelidad/coherencia bajos por el
problema puntual — `run.js` le da a Sonnet UN intento automático de
regeneración completa citando el motivo exacto del Guardia
(`buildAmbiguityCorrectiveNote`), y vuelve a consultar al Guardia sobre el
resultado. Si aprueba: se salta la pausa, se sobrescribe `song.txt`, y la
caché se reemplaza con la versión BUENA (nunca queda la ambigua cacheada).
Si sigue sin aprobar: cae a la pausa de siempre, pero mostrándole al humano
la MEJOR versión disponible, no la original. UN solo intento — nunca un
loop; si el perfil no es "ambigüedad pura" (letra mala en varios frentes, o
la extracción SÍ encontró algo sin respaldo), no se activa y va derecho a
la pausa humana, exactamente como antes.

**Validado en vivo, no solo con mocks** (misma lección del caso Haiku):
`validarGuardia` contra la API real con la encuesta y letra EXACTAS del
incidente confirmó las tres piezas encadenadas — el rechazo real quedó
anclado a línea, `shouldAttemptAmbiguityRecovery` disparó `true` sobre la
respuesta real (no solo sobre datos tipeados a mano), y
`buildAmbiguityCorrectiveNote` armó una instrucción correctiva clara y
sin pedir invención. No se gastó en probar el regen completo (reusa
`generateSongWithSelfCorrection`, ya probado en todo el resto del pipeline).

**Lo que sigue sin tocarse:** el poder de veto del Guardia. Una letra
genuinamente mala en varios frentes, o con un hecho de verdad inventado,
sigue yendo directo a pausa humana sin ningún atajo — el pedido fue que la
AMBIGÜEDAD real (no la calidad en general) deje de trabar canciones buenas.

## "El propósito de tener dos modelos es que se corrijan entre ellos" — generalización de la recuperación automática, la misma noche (2026-07-15)

Seguimiento inmediato de la recuperación por ambigüedad (entrada anterior).
Hector aclaró el objetivo de fondo: el propósito de tener Sonnet (genera) +
Haiku (audita) separados es que se corrijan ENTRE ELLOS sin que él tenga
que intervenir manualmente — la pausa humana debe ser el ÚLTIMO recurso, no
el primero. La versión de la entrada anterior era deliberadamente estrecha
("solo el perfil de ambigüedad pura, un intento") por priorizar "no
debilitar el gate" — pero eso dejaba afuera EXACTAMENTE los casos donde más
falta hacía la auto-corrección (una letra rechazada por varios motivos a la
vez, o con un hecho realmente inventado).

**Generalización** (`lib/ollama-guardia.js`):
- `shouldAttemptGuardiaRecovery` reemplaza la condición estrecha por una
  general: CUALQUIER rechazo del Guardia con al menos un veredicto que
  rechazó, mientras queden intentos (`MAX_GUARDIA_RECOVERY_ATTEMPTS = 2`).
  Ya no exige "0 hechos sin respaldo" ni "resto de puntajes buenos" — una
  letra mala en varios frentes también recibe su oportunidad de corregirse
  sola.
- `buildGuardiaCorrectiveNote` reemplaza la nota estrecha (solo fidelidad/
  coherencia) por una que cita TODOS los tipos de problema, y si
  `hechosSinRespaldo` tiene algo, agrega una sección separada con
  instrucción de ELIMINAR el hecho (no solo "aclarar" — es invención real,
  distinto del caso de ambigüedad).
- `run.js`: el bloque de recuperación (antes un `if` de un solo tiro) pasó
  a un `while` acotado por `shouldAttemptGuardiaRecovery` — hasta 2 rondas
  de regen+re-consulta al Guardia antes de caer a la pausa de siempre. Cada
  ronda adopta el resultado (apruebe o no) como la nueva "mejor versión" y
  sobrescribe song.txt; solo si se agotan los 2 intentos sin aprobación cae
  a `pauseForHumanInteraction`, mostrando la versión más corregida
  disponible, nunca la original.

**Lo que sigue exactamente igual, sin excepción:** el dominio de Suno/
créditos. Esta generalización es 100% sobre la LETRA (Sonnet+Haiku,
centavos de Haiku, nunca Suno) — la regla dura de nunca clickear Create sin
confirmación humana no se tocó ni se va a tocar por este pedido; son dos
dominios de automatización completamente separados y Hector fue explícito
sobre eso.

**Costo:** en el peor caso (letra que rechaza 2 veces seguidas) esto suma
hasta 2 regens completos de Sonnet + hasta 4 pasadas extra de Haiku sobre
lo que ya corría — sigue siendo centavos (Haiku) más el costo normal de
Sonnet que el pipeline ya paga siempre, pero es explícitamente MÁS gasto de
tokens que la versión anterior a cambio de MENOS pausas. Trade-off
aceptado a propósito: el objetivo explícito es reducir intervención manual,
no minimizar tokens.

**19 tests nuevos entre las dos entradas de esta noche** (`test/ollama-guardia.test.js`)
cubren tanto la versión estrecha original (que se mantiene como clasificador
de "es esto ambigüedad pura o no" para calibración futura, aunque ya no
gatea la decisión) como la general nueva.
