# Lessons / gotchas

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
