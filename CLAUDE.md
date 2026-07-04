# Canción Eterna — Pipeline de producción de canciones

## ════════════════════════════════════════════════════════════════════
## 🛑 REGLA DURA #1 — NUNCA hacer "Submit to QA" — NO NEGOCIABLE
## ════════════════════════════════════════════════════════════════════
## El código JAMÁS hace click en "Submit to QA" o "Complete Song".
## - upload-to-flow.js sube el MP3 y SE DETIENE. Punto.
## - El Submit es siempre manual. Siempre. Sin excepciones.
## - No es un flag configurable. No hay default que lo active.
## - Motivo: un submit automático cuesta un redo sin pago si el
##   artista cambia de opinión después de escuchar.
## - Si alguien en el futuro quiere agregar el submit automático: NO.
## ════════════════════════════════════════════════════════════════════

Pipeline para crear canciones cristianas personalizadas (negocio tipo SongFinch).
Esta carpeta es un repo git (sin remoto). Hacé commit antes de cambios grandes.

## Flujo completo (en orden)

`node start-flow.js` es el orquestador — corre todo esto como procesos hijo
reales. El flujo hoy solo necesita 1 interacción manual: hacer Submit to QA
(se sube sola la versión que recomienda el análisis de audio — B por defecto
si no hay reporte confiable; para cambiarla: `node upload-to-flow.js --version A|B`).
Ver `start-flow.js` en "Archivos clave" para los flags que saltean pasos.

1. **`node run.js`** — Abre el Artist Flow de cancioneterna.com, entra al Flow,
   resuelve la asignación activa (o asigna la más urgente). Lee la encuesta,
   genera letra + estilo Suno + título vía `lib/llm-provider.js` (Claude Sonnet 5
   por default; `--provider=gemini` usa Gemini 3.5 Flash como alternativa manual;
   `--dry-run` genera con un mock local sin llamar a ninguna API, salteando
   Playwright por completo — para probar el pipeline sin gastar saldo). El system
   prompt y el checklist QA están dentro de run.js. Guarda en `song.txt` y lo abre
   en Notepad. Cachea la respuesta por hash de la encuesta en `.cache/` (no se
   usa ni se escribe en `--dry-run`) para no re-gastar la llamada al LLM si
   Playwright se cae después. Maneja REDO automáticamente: si hay banner naranja
   de QC, lee el feedback + letra actual y pide el fix preciso + una pasada de
   mejora a 9-10/10, en vez de generar desde cero. NO escribe en los campos del Flow.

2. **(manual)** Gabo revisa/edita `song.txt`.

3. **Suno** — `suno-fill.js` llena el formulario (título/letra/estilo/sliders).
   Si falla un selector de la UI, cae a un fallback interactivo (`pauseForHumanInteraction`
   en `lib/playwright-helpers.js`): pausa, avisa por ntfy y espera un ENTER en la
   terminal en vez de matar el proceso. `start-flow.js` luego corre
   `lib/suno-create-dl.js` automáticamente: chequea créditos de Suno, verifica el
   formulario, clickea Create una vez (Suno v5.5 genera 2 versiones por click) y
   descarga ambos MP3 a `Downloads/suno/`. Con `--no-auto-create` se saltea este
   paso y Create + descarga quedan manuales.

4. **`verify-audio.js`** — corre automáticamente apenas aterrizan los 2 MP3 y
   **start-flow.js espera a que termine** (ya no es fire-and-forget en background)
   para poder leer su resultado. Analiza duración, Whisper, Levenshtein contra la
   letra, nombres de destinatarios ausentes, calidad perceptual con CLAP (claridad
   vocal, producción, emoción, artefactos, final) y (con `--demucs`, el default)
   separa voz y chequea instrumental accidental. Escribe `verify-report.json` con
   un puntaje por versión (`pickBestVersion` en `lib/audio-analysis.js`) y una
   recomendación — INFORMA, nunca decide solo. `--no-auto-verify` saltea este paso;
   `--fast-verify` fuerza el modo rápido (Whisper small/CPU) en vez de `--demucs`.

5. **`flow-submit.js`** — llena Título/Letra/Notas en el Flow. Toma screenshot.
   Nunca clickea Submit to QA (ver Regla Dura #1).

6. **(automático)** Si `verify-report.json` existe, es de la canción actual
   (chequeado contra `state.json` — nunca confía en un reporte viejo o de otra
   canción) y el análisis de este run terminó bien, `start-flow.js` muestra la
   recomendación con puntajes en consola y **sube automáticamente la versión
   recomendada** (`pickBestVersion`: duración, letra, clipping, corte abrupto,
   CLAP) con `node upload-to-flow.js --version A|B` (sube el MP3 al Flow +
   copia de respaldo en `mp3/[Song ID] - [Título].mp3`, solo si el título de
   `song.txt` coincide con `state.json`). Sin reporte confiable sube la B por
   defecto (A si solo se descargó una versión). Si Gabo prefiere la otra, la
   sube a mano con `node upload-to-flow.js --version A|B` (pisa la subida en el
   Flow) antes del Submit. **SE DETIENE ahí — nunca hace Submit to QA** (Regla
   Dura #1).
   El QA Dashboard (`qa-dashboard.js`) ya NO forma parte de la orquestación —
   quedó como herramienta standalone opcional (`node qa-dashboard.js`).

7. **(manual)** Gabo hace Submit to QA en el Flow. Es la ÚNICA interacción
   manual del flujo normal.

8. **(automático)** Mientras tanto `start-flow.js` queda esperando SIN límite de
   tiempo (pedido de Gabo 2026-07-03 — corta solo al detectar el Submit o si
   Chrome se cierra; fallback: `--done`) y detecta el Submit solo. Muestra un
   **candado visual** en la pestaña de trabajo (badge rojo "🔒 AÚN NO" + botón
   Submit atenuado hasta el minuto 25, verde después — cosmético y fail-open:
   nunca clickea nada, un F5 lo limpia, y se restaura al salir del loop). Al arrancar la espera hace un **pre-chequeo del botón "Submit to QA"**
   (solo verificación, jamás click — Regla Dura #1): si no está visible avisa por
   consola + ntfy para descubrir un cambio de UI temprano. Mientras espera muestra
   un **countdown en vivo por segundo** en la terminal (con `\r`, no infla el
   run-log; el registro en disco sigue siendo la línea [Timer] de cada 30s), hace
   **keep-alive de sesión** (scroll de 1px ida y vuelta en la pestaña del Flow
   cada 5 min, para que la sesión no caduque mientras Gabo escucha/revisa) y tiene
   **failsafe de suspensión**: si el reloj salta >2 min entre iteraciones (PC
   suspendida), avisa por consola + ntfy urgent con el tiempo REAL transcurrido.
   Avisa por ntfy al celular cuando se alcanza el rango seguro de Submit (25 min)
   y cuando se está por exceder (30 min). Pollea "Recent completions" en `/artists/flow/create`
   usando una **pestaña dedicada en background** (nunca recarga la pestaña donde
   Gabo trabaja), verifica que el título de la primera card coincida con
   state.json (sin título en state.json NO auto-detecta — evitaría registrar la
   canción anterior por error) y corta temprano si Chrome se cierra. Al detectar
   la card corre el cierre automáticamente: extrae el tiempo de sesión (ej. "26
   min session" → Time="00:26", Total Time=0.43), toma un screenshot recortado de
   la card (→ `screenshots/YYYY-MM-DD_slug.png`), lo sube a Drive, elige el tab
   mensual más reciente del Google Sheet (ej. "JULY 2026") y llena la primera fila
   vacía con Date(A)/Total Songs=1(B)/Total Time(C)/Time(D)/Title(E)/Song ID(F). Si
   la extracción de tiempo falla (Chrome cerrado, título no coincide, etc.) se
   loguea un aviso y se continúa sin C ni D — anti-duplicados siempre activo. Marca
   state.json como completado. **`node start-flow.js --done`** (o `node sheets.js`)
   queda como fallback si la sesión se cortó antes o venció el timeout (avisa
   por ntfy en ese caso).

9. **(manual)** Gabo llena Remarks + pega Flow Screenshot. Si el tiempo no se pudo
   auto-detectar (aviso en consola), también llena Total Time y Time a mano.

## Reglas importantes

- **El tiempo se extrae automáticamente de "Recent completions"** cuando Chrome está
  abierto y el título coincide. Si falla, queda vacío para que Gabo lo llene a mano.
- **La verificación visual antes de Create NO es opcional** — ya atrapó defectos
  reales (ej. el bloque "Advertencias" colándose dentro de la letra). Nunca saltearla.
- **Checkpoints de verificación humana (opt-in)**: con `--pause`, start-flow.js
  pausa con ENTER (beep + ntfy) ANTES del Create de Suno y ANTES de subir el MP3
  al Flow. Por default NO pausan (la única interacción manual es el Submit).
  `confirmToContinue` en `lib/playwright-helpers.js` (checkpoint amistoso)
  convive con `pauseForHumanInteraction` (fallback de emergencia) — no
  confundirlos. El Submit manual no se toca jamás.
  Además, suno-fill.js ahora DETIENE (pausa interactiva) si la relectura del
  formulario no coincide con song.txt (secciones faltantes o final truncado),
  en vez de solo loguearlo y dejar que el Create gaste créditos en una letra rota.
- **`suno-verify-lyrics-expanded.png` puede no existir** — Suno le quitó el botón
  "Expand lyrics box" en un rediseño (2026-07-02). `suno-fill.js` detecta que no
  está y en su lugar genera `suno-verify-lyrics-top.png` (scrollea el panel Y el
  editor al inicio para mostrar Verse 1, no el final donde queda el cursor tras
  tipear) — y borra el `.expanded.png` viejo si quedó de una corrida anterior,
  para que nunca quede un screenshot con pinta de fresco mostrando la letra de
  OTRA canción (pasó de verdad: overview.png con timestamp de la corrida actual
  al lado de expanded.png con la letra de una canción de horas antes, porque el
  bloque entero se saltaba en silencio). Si volvés a ver `suno-verify-lyrics-
  expanded.png` generarse, es que Suno restauró el botón — ambos caminos conviven
  en el código.
- **Todo el pipeline comparte UNA sola instancia de Chrome en el puerto 9333**
  (`ChromeAutomationProfile`, `Profile 1`): run.js, suno-fill, flow-submit,
  upload y el poller se conectan por CDP a la misma; el primero que la necesita
  la lanza. Ya no existe el conflicto viejo de dos Chromes peleándose el perfil
  (el poller usaba el 9334 con ventana propia) — nunca reintroducir una segunda
  instancia sobre el mismo perfil.
- **Clockify** = solo reuniones, nunca canciones. **Flow Screenshot** = siempre
  obligatorio. **Clockify Screenshot** = solo si hubo reuniones ese día.

## Archivos clave

- `run.js` — generación de letra (~900 líneas). Usa `lib/flow-helpers.js` para entrar
  al Flow, `lib/llm-provider.js` para el LLM, `lib/cache-helpers.js` para la caché de
  respuestas, `lib/text-helpers.js` para extraer nombres de destinatarios, y escribe
  `state.json` al terminar. `--provider=claude|gemini` (default claude), `--dry-run`
  (mock local, sin API ni Chrome, útil para probar el pipeline sin gastar saldo).
- `lib/song-validate.js` — `hardValidate`, `validateContentForWrite`, `parseSections`,
  `extractField`: la validación estructural dura de la letra (movida desde `run.js` para
  poder testearla sin ejecutar el pipeline entero). Cubierta por
  `test/song-validate.test.js`, parte de la suite completa (`npm test`, 53 casos entre
  todos los `test/*.test.js`, 100% local sin API — incluye las regresiones reales de
  LESSONS.md: límites de palabra con tildes, N/A condicional, preámbulo antes de
  Título, símbolos no-✓ en el checklist, nombres multi-destinatario, respelling
  fonético, hash de song.txt, rotación de logs, parseo de sesión).
  ⚠️ Cada regla nueva del `SYSTEM_PROMPT` de `run.js` debe chequearse contra este
  validador Y agregarse un caso al test.
- `lib/llm-provider.js` — `generate(provider, surveyText, systemPrompt, isDryRun)`:
  unifica las llamadas a Anthropic (`claude-sonnet-5`) y Gemini (`gemini-3.5-flash`)
  en un solo lugar. En `isDryRun` devuelve siempre el mismo texto mock, sin llamar a
  ninguna API — así `run.js` no necesita Chrome ni credenciales para probarse.
  Reintenta hasta 3 veces con backoff exponencial los errores transitorios (red,
  5xx, 429); los errores de configuración (API key faltante) y el resto de los
  4xx fallan al instante sin reintentar.
- `lib/cache-helpers.js` — caché local en `.cache/<hash-de-encuesta>.json` de
  respuestas del LLM que pasaron QA. Se salta por completo en `--dry-run` (nunca lee
  ni escribe) para que un test con mock no contamine la caché de una encuesta real.
- `lib/text-helpers.js` — `extractFirstNames(surveyText)`: extracción de nombres del
  destinatario filtrando palabras de relleno (mis/hijos/y/...). Único lugar donde
  vive esta lógica — la usan `run.js` y `verify-audio.js`, nunca duplicarla de nuevo
  (ver el bug multi-destinatario en LESSONS.md, que fue justo por tener esto duplicado).
  También `extractLyricNameVariants(lyricsText, firstNames)`: empareja el nombre de
  encuesta con su variante fonética real en la letra (ej. "Jamie"→"Yeimi") para que
  `missingNames` en `lib/audio-analysis.js` no marque como "ausente" un nombre que
  Suno sí cantó, solo reescrito (ver LESSONS.md, auditoría 2026-07-03).
- `lib/song-file.js` — `parseSongFile(content)`: parser único de song.txt
  (título/voz/estilo/letra/notes/songId). Único lugar donde vive esta lógica —
  la usan `suno-fill.js`, `flow-submit.js` y `lib/sheets-core.js`, nunca duplicarla
  de nuevo (había 3 copias divergentes hasta la auditoría 2026-07-03, LESSONS.md).
- `lib/session-time.js` — `parseSessionTime(text)`: parsea el texto de duración de
  "Recent completions" ("26 min session", "1h 5min session", "1h session") a
  `{ timeHHMM, totalTimeDecimal }`. Extraída de start-flow.js para poder testearla
  (start-flow.js no es un módulo requireable). Ver LESSONS.md por el bug real que
  tenía la rama de horas exactas (inalcanzable por el selector de DOM que la
  alimentaba, arreglado en la misma auditoría 2026-07-03).
- `lib/hygiene.js` — `rotateOldRunFiles()`: borra archivos de `logs/` y
  `screenshots/` de más de 30 días. Se llama al final de un `start-flow.js --done`
  exitoso (best-effort, nunca lanza ni bloquea el cierre de la canción).
- `suno-fill.js` — llenado de Suno (canónico; suno-fill2.js fue fusionado y borrado).
  Si un selector de la UI falla, cae a `pauseForHumanInteraction` en vez de matar
  el proceso — ver `lib/playwright-helpers.js`.
- `suno-create.js` — clickea Create manualmente (standalone; start-flow.js usa suno-create-dl.js)
- `suno-open-for-login.js` — Chrome standalone para login
- `flow-submit.js` — llenado de Título/Letra/Notas en el Flow (`#title`/`#lyrics`/`#notes`),
  nunca clickea Complete Song/Submit to QA. Mismo fallback interactivo que suno-fill.js.
  La nota SIEMPRE lleva el formato estándar de song.txt ("`<fecha>. Hector. PS0180.
  Letra + Suno.`", tal cual viene de la línea `NOTES:`, sin el Song ID). Si
  state.json marca `isRedo` Y el título coincide con song.txt, se agrega
  "Redo Fix, corregido" DEBAJO de esa nota estándar (nunca en su lugar — bug real
  arreglado 2026-07-03/04: antes la reemplazaba por completo, perdiendo la nota
  estándar en cada REDO). Todo el bloque (estándar + redo si aplica) se APPENDEA
  debajo del feedback existente en el campo del Flow, nunca lo reemplaza. Se
  conecta a la tab del Flow con `connectToFlowTab` (`lib/playwright-helpers.js`,
  compartida con `upload-to-flow.js` desde la auditoría 2026-07-03 — antes eran
  dos copias divergentes).
- `setup-whisper.js` — instala/verifica Python, faster-whisper, ffmpeg. Correr una vez.
- `verify-audio.js` — analiza los 2 MP3 (duración + Whisper + comparación letra + nombres
  ausentes). INFORMA, no decide, no sube nada. Requiere setup-whisper.js previo. Con
  `--demucs`: separa voz (htdemucs_ft) + Whisper large-v3 en CUDA (fallback a CPU
  automático), agrega chequeos de corte abrupto/clipping/tags cantados/instrumental
  accidental, comparación por Levenshtein (con umbral duro: <75% dispara "ALUCINACIÓN
  GRAVE"), y nombres ausentes en el audio. Sin el flag, comportamiento idéntico al de
  siempre (Whisper small en CPU). Escribe `verify-report.json` (resumen de ambas
  versiones + recomendación de `pickBestVersion` + timestamp) para que `start-flow.js`
  lo lea después. Ver LESSONS.md para instalación (torch CUDA, demucs).
- `upload-to-flow.js` — sube el MP3 elegido al Flow con nombre limpio (QA quiere
  ver solo el título en la UI, sin fecha ni sufijo A/B: se sube una copia temporal
  renombrada a `[Título].mp3`) y guarda una copia de respaldo en
  `mp3/[Song ID] - [Título].mp3`. Ambas cosas solo si el título de song.txt
  coincide con state.json — si no coinciden, sube el archivo original tal cual,
  sin renombrar. SE DETIENE sin Submit to QA (Regla Dura #1).
  Uso: `node upload-to-flow.js --version A|B` o `--file "ruta.mp3"`.
- `qa-dashboard.js` — Express local (puerto 3000). **Ya NO lo forkea
  `start-flow.js`** (la orquestación sube la Versión B automáticamente); quedó
  como herramienta standalone opcional: `node qa-dashboard.js` muestra
  survey/letra/QA/audio A vs B con botones "🟢 Aprobar y Subir Versión A/B"
  (`POST /approve`, corre `upload-to-flow.js` internamente) y "✋ No subir
  ninguna" (`POST /reject`), más un timer de la sesión del Flow.
- `start-flow.js` — orquestador único. Modos:
  - `node start-flow.js` = flujo completo (genera, llena Suno, Create, descarga MP3,
    corre verify-audio.js con `--demucs` en paralelo con el llenado del Flow, muestra
    la recomendación, sube automáticamente la versión recomendada (B por defecto si
    no hay reporte confiable) y queda esperando hasta 30 min desde la asignación
    a detectar el Submit to QA manual — pestaña dedicada en background, título
    verificado contra state.json, timer en consola + avisos ntfy a los 25 y 30
    min — para cerrar solo (Sheets + Drive). Fallback:
    `start-flow.js --done` si la sesión se cortó antes o venció el timeout.
  - `node start-flow.js --no-auto-create` = igual pero sin Create/descarga automáticos.
  - `node start-flow.js --no-auto-verify` = igual pero sin correr verify-audio.js
    (sin verify-report.json no hay recomendación ni auto-upload — todo queda manual).
  - `node start-flow.js --fast-verify` = el auto-verify usa Whisper small/CPU en vez de `--demucs`.
  - `node start-flow.js --resume` = retoma un pipeline cortado a mitad de camino usando
    `state.json`: salta letra/Suno/Flow ya completados. Nunca re-clickea Create (evita
    gastar créditos doble) — si los MP3 no están en disco (ventana de 180 min), Create y
    descarga quedan manuales. Si `song.txt` no coincide con `state.json`, aborta con error
    en vez de mezclar canciones.
  - `node start-flow.js --dry-run` = ensayo completo sin gastar nada: run.js con
    mock local (cero API), cero Chrome/Suno/Flow (simulados), pero ejercita DE
    VERDAD los checkpoints de ENTER y las notificaciones ntfy (marcadas
    [DRY-RUN]). Respalda song.txt antes y lo restaura SIEMPRE al final — el
    mock nunca pisa una canción real en curso.
  - `node start-flow.js --pause` = activa los 2 checkpoints de verificación
    humana (ENTER antes del Create de Suno y antes de subir el MP3 al Flow):
    pausan, hacen beep, avisan por ntfy y esperan ENTER. Por DEFAULT están
    DESACTIVADOS (decisión de Gabo 2026-07-03): la única interacción manual del
    flujo normal es el Submit to QA. No afecta la Regla Dura #1 (el Submit to
    QA no existe en el código, con o sin flag).
  - `node start-flow.js --loop` = canciones en continuo: corre el flujo completo,
    espera el Submit manual, cierra, y busca la siguiente (vigía si la cola está
    vacía). Un ciclo fallido avisa por ntfy y el loop sigue. En --loop el
    checkpoint pre-Create se saltea siempre (aunque haya --pause). La única
    interacción por canción sigue siendo el Submit to QA.
  - `--max-rerolls N` = tope del auto-reroll por mala pronunciación (default 2,
    0 lo desactiva). Si verify-report.json dice que el nombre del destinatario
    no se escucha en NINGUNA versión (missingNames en ambas, con probability de
    palabra de Whisper < 0.65 contando como ausente), los MP3 rechazados van a
    Downloads/suno/rejected/ (si el reroll falla se restauran), se re-clickea
    Create sobre el mismo formulario y se re-analiza. Solo cuando Create corrió
    en ESTA corrida — nunca en --resume. Cada reroll gasta ≈10 créditos y avisa
    por ntfy; al agotarse, sube la mejor versión igual con aviso urgent.
  - `node start-flow.js --done` = cierre: registra en la hoja + marca state.json.
  - `node start-flow.js --poll [N]` = vigía de cola. Default: intervalo aleatorio
    10-15s. Acepta minutos ("3"), segundos ("30s") o rangos ("10-15s", "1-2").
    Reusa el Chrome del puerto 9333 si ya está abierto (no lanza ventana propia).
    Si el flujo normal arranca sin canciones en cola, cae solo a este modo.
  - `poll-flow.js` es ahora un redirect deprecated a `start-flow.js --poll`.
  - Cada corrida (normal o `--poll`) escribe toda su salida — la propia + la de cada
    script hijo (`run.js`, `suno-fill.js`, `flow-submit.js`, `upload-to-flow.js`) — en
    `logs/run-<timestamp>.log`, además de mostrarla en la terminal como siempre. El
    auto-verify en background sigue con su log aparte (`logs/verify-audio-auto-*.log`).
- `lib/suno-create-dl.js` — chequea créditos de Suno, Create × 1 (Suno v5.5 genera 2
  versiones por click), espera generación y descarga ambos MP3 a Downloads/suno/. Si
  falla clickear Download → MP3 Audio en la UI, cae a `pauseForHumanInteraction` en
  vez de tirar error — el watcher de filesystem y el fallback humano corren en
  paralelo (`Promise.race`), y el que pierde se cancela limpio (nunca queda un
  listener de stdin huérfano ni una promesa sin resolver).
- `lib/audio-match.js` — encuentra los 2 MP3 por título + recencia en Downloads/suno/.
- `lib/audio-analysis.js` — ffprobe (duración) + Whisper (transcripción) + comparación
  letra + CLAP (calidad perceptual: claridad vocal, producción, emoción, artefactos,
  final — ±15 pts informativo, no decide solo) + `pickBestVersion(reportA, reportB)`:
  puntúa cada versión (duración, corte abrupto, clipping, fidelidad de letra, nombres
  ausentes, instrumental accidental, CLAP) y recomienda una — siempre orientativo,
  nunca decide solo.
- `lib/transcribe.py` — script Python que usa faster-whisper para transcribir.
- `lib/clap_score.py` — script Python que evalúa calidad de audio con CLAP (modelo
  laion/clap-htsat-unfused). Recibe 1+ MP3, devuelve JSON con score 0-100 global y
  5 dimensiones. 100% local, cero API de nube. Sigue el mismo patrón que
  transcribe.py (batching, CUDA fallback, JSON a stdout). Requiere:
  `pip install transformers librosa` (torch ya está para Whisper). Degrada con
  gracia si no está instalado.
- `lib/ntfy.js` — notificaciones push vía ntfy.sh. Tópico privado con sufijo aleatorio
  (ntfy.sh no tiene auth — un nombre adivinable deja leer/mandar notificaciones a
  cualquiera). Si el tópico cambia otra vez, avisar: hay que re-suscribirse en la app.
- `lib/suno-selectors.js` — data-testid/aria-label/texto de la UI de Suno usados por
  `suno-fill.js`, `lib/suno-create-dl.js` y `start-flow.js`, centralizados acá (mismo
  patrón que `lib/flow-helpers.js`) para que un cambio de selector no quede
  desincronizado entre archivos. `STYLE_TEXTAREA` se ancla a
  `[data-testid="create-form-styles-wrapper"] textarea` desde el 2026-07-04 —
  Suno rotó el placeholder de ejemplo (ya no contiene la palabra "style"),
  detectado con `suno-selector-drift.js`.
- `suno-selector-drift.js` — script standalone de SOLO LECTURA (nunca clickea nada,
  nunca gasta créditos) que abre suno.com/create con el Chrome ya logueado
  (puerto 9333) y verifica que todos los selectores de `lib/suno-selectors.js`
  (+ Download/MP3 Audio del menú ⋯) sigan matcheando algo real. Corré
  `node suno-selector-drift.js` después de cualquier sospecha de rediseño de
  Suno — guarda `selector-drift-report.md` (gitignored, es una foto de un
  momento) con el detalle. Originado por Antigravity (2026-07-04), revisado
  y con el fix de `STYLE_TEXTAREA` aplicado tras confirmarlo en vivo.
- `sheets.js` — wrapper standalone de `lib/sheets-core.js` (registro en Google Sheet)
- `lib/playwright-helpers.js` — helpers de Playwright (clickByText, setSliderValue,
  expandIfCollapsed, connectToSunoTab, isLoggedIn). Además:
  - `isPortUp(port)` / `ensurePortIsFree(port)` — chequeo de puerto CDP antes de
    lanzar o conectar Chrome, para fallar con un mensaje claro en vez de un stack
    trace feo. `run.js` usa `ensurePortIsFree(9333)` para asegurarse de que no hay
    una sesión de Suno abierta antes de lanzar su propio Chrome; `flow-submit.js`,
    `suno-fill.js` y `upload-to-flow.js` usan `isPortUp` al revés (avisan si Suno
    NO está abierto antes de conectarse).
  - `pauseForHumanInteraction(reason, options)` — fallback interactivo: beep +
    aviso por ntfy + pausa esperando un ENTER en la terminal. Reemplaza los
    `process.exit(1)` viejos ante fallos de UI (selector roto, cambio de Suno/Flow)
    para que el pipeline nunca muera solo — se detiene, avisa, y espera que Gabo
    intervenga a mano y confirme.
- `lib/flow-helpers.js` — `enterFlowAndEnsureAssignment`: lógica COMPARTIDA para entrar
  al Flow y garantizar asignación activa (Enter Flow + Assign Most Urgent Song + retry).
  La usan run.js Y start-flow.js, así no divergen (ver bug del 2026-06-28 en LESSONS.md).
- `lib/pipeline-state.js` — `state.json`: rastrea Song ID + título + etapa actual entre
  scripts, para detectar si se está por procesar la canción equivocada. `upload-to-flow.js`
  y `start-flow.js` lo cruzan contra `song.txt`/`verify-report.json` antes de confiar
  en ellos — nunca asumir que un archivo en disco es de la canción actual solo porque existe.
  También guarda `songTxtHash` (hash de song.txt al momento de `startNew()`);
  `suno-fill.js` y `flow-submit.js` llaman `checkSongTxtContent()` al leer song.txt y
  avisan (nunca abortan — Gabo puede editar a mano) si cambió sin explicación desde que
  se generó — pensado para detectar un `--dry-run` suelto pisando la letra real.
- `lib/sheets-core.js` — lógica de registro en la hoja, importable (la usa sheets.js y
  el modo --done de start-flow).
- `lib/preflight.js` — health-check (API key, credenciales, deps) antes de arrancar.
- `song.txt` — salida de run.js. Formato: bloque **Título:**/**Voz:**/**Trato:**/
  **Estilo Suno:**, luego `---`, las 6 secciones [Verse 1] etc, opcionalmente
  **Advertencias:**, y al final línea `NOTES:` con el Song ID. Cualquier parser de
  "solo la letra" debe cortar en lo que venga primero: **Advertencias:** o NOTES:.
- `survey.txt` — encuesta cruda leída del Flow
- `state.json` — estado del pipeline (lo escribe run.js, lo leen los demás). Efímero —
  no se commitea, se pisa en cada corrida real.
- `.cache/` — respuestas del LLM cacheadas por hash de encuesta (`lib/cache-helpers.js`).
  No se commitea (tiene letras reales de clientes) — está en `.gitignore`.
- `mp3/` — copias de respaldo de los MP3 subidos, nombradas `[Song ID] - [Título].mp3`
  (las genera `upload-to-flow.js`).
- `google-credentials.json` — credenciales del service account para sheets.js
- `LESSONS.md` — log de bugs reales ya arreglados. LEERLO antes de debuggear algo
  que se sienta familiar, y agregarle cuando aparezca un bug nuevo no obvio.

## Estructura de letra (la valida run.js)

Verse 1 → Chorus 1 → Verse 2 → Chorus 2 → Bridge → Outro. Cada sección exactamente
4 líneas. Nombre del dedicado: ausente en Verse 1, primera palabra de cada Chorus
(una sola vez). Chorus 1 ≠ Chorus 2. Bridge = el detalle más vulnerable. Números,
meses y siglas en palabras completas. Sin em dash / punto y coma / dos puntos.
Trato consistente (tú/usted/vos). Estilo Suno termina en "Latin American Spanish,
neutral accent, seseo". Multi-destinatario y respelling fonético tienen reglas
propias en el system prompt — NO romper la lógica de extracción de nombres de
hardValidate (ver el bug multi-destinatario en LESSONS.md).

## Cómo trabajar acá (para ahorrar tokens)

- Cuando Gabo diga "node run.js" significa correr el flujo completo hasta el punto
  de verificación visual (no solo el script suelto).
- Los pasos son procesos hijo reales (`node <script>.js`), no reimplementaciones —
  cada script sigue funcionando standalone.
- Re-leé `song.txt` justo antes de llenar Suno (Gabo a veces corre run.js varias
  veces seguidas y song.txt cambia). Si pasó un rato, confirmá con Gabo cuál Song ID
  es el objetivo.
- Respondé corto y directo. No re-expliques diseño ya establecido (REDO, verificación
  visual, etc.) — ya está acordado.
