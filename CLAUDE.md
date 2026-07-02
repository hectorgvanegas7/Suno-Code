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
reales. El flujo hoy solo necesita 2 interacciones manuales: confirmar qué
versión subir, y hacer Submit to QA. Ver `start-flow.js` en "Archivos clave"
para los flags que saltean pasos individuales.

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
   letra, nombres de destinatarios ausentes, y (con `--demucs`, el default) separa
   voz y chequea instrumental accidental. Escribe `verify-report.json` con un
   puntaje por versión (`pickBestVersion` en `lib/audio-analysis.js`) y una
   recomendación — INFORMA, nunca decide solo. `--no-auto-verify` saltea este paso;
   `--fast-verify` fuerza el modo rápido (Whisper small/CPU) en vez de `--demucs`.

5. **`flow-submit.js`** — llena Título/Letra/Notas en el Flow. Toma screenshot.
   Nunca clickea Submit to QA (ver Regla Dura #1).

6. **(automático)** Si `verify-report.json` existe, es de la canción actual
   (chequeado contra `state.json` — nunca confía en un reporte viejo o de otra
   canción) y el análisis de este run terminó bien, `start-flow.js` muestra la
   recomendación con puntajes y pregunta `¿Subir Versión A? (s/n/B)`. **Gabo
   siempre escucha las 2 versiones antes de responder** — la recomendación es
   orientativa, no una decisión automática.

7. **(automático tras confirmar)** Si Gabo confirma una versión, `start-flow.js`
   corre `node upload-to-flow.js --version A|B` por él. Sube el MP3 al Flow y
   además guarda una copia de respaldo en `mp3/[Song ID] - [Título].mp3` (solo si
   el título de `song.txt` coincide con `state.json`, para no etiquetar mal el
   archivo). **SE DETIENE ahí — nunca hace Submit to QA** (Regla Dura #1). Si no
   hay reporte disponible o Gabo prefiere no confiar en él, sigue existiendo el
   camino 100% manual: `node upload-to-flow.js --version A|B`.

8. **(manual)** Gabo hace Submit to QA en el Flow.

9. **(automático al final de `node start-flow.js`)** El proceso pausa y pregunta
   `¿Ya hiciste Submit to QA? (s/n)`. Al responder `s`, corre automáticamente la
   lógica de cierre: conecta al Chrome del puerto 9333, navega a
   `/artists/flow/create`, lee la primera card de "Recent completions", verifica
   que el título coincida con state.json, extrae el tiempo de sesión (ej. "26 min
   session" → Time="00:26", Total Time=0.43) y toma un screenshot recortado de la
   card (→ `screenshots/YYYY-MM-DD_slug.png`). Luego lee `song.txt`, elige el tab
   mensual más reciente del Google Sheet (ej. "JULY 2026") y llena la primera fila
   vacía con Date(A)/Total Songs=1(B)/Total Time(C)/Time(D)/Title(E)/Song ID(F). Si
   la extracción de tiempo falla (Chrome cerrado, título no coincide, etc.) se
   loguea un aviso y se continúa sin C ni D — anti-duplicados siempre activo. Marca
   state.json como completado. **`node start-flow.js --done`** (o `node sheets.js`)
   queda como fallback si la sesión se cerró antes de responder.

10. **(manual)** Gabo llena Remarks + pega Flow Screenshot. Si el tiempo no se pudo
    auto-detectar (aviso en consola), también llena Total Time y Time a mano.

## Reglas importantes

- **El tiempo se extrae automáticamente de "Recent completions"** cuando Chrome está
  abierto y el título coincide. Si falla, queda vacío para que Gabo lo llene a mano.
- **La verificación visual antes de Create NO es opcional** — ya atrapó defectos
  reales (ej. el bloque "Advertencias" colándose dentro de la letra). Nunca saltearla.
- **No correr run.js mientras una sesión de Suno está abierta** — comparten el
  mismo perfil de Chrome (`ChromeAutomationProfile`, `Profile 1`) y la conducta
  singleton de Chrome puede cerrar/hijackear la ventana de la otra. Secuenciá o avisá.
- **Clockify** = solo reuniones, nunca canciones. **Flow Screenshot** = siempre
  obligatorio. **Clockify Screenshot** = solo si hubo reuniones ese día.

## Archivos clave

- `run.js` — generación de letra (~900 líneas, validación estructural dura adentro).
  Usa `lib/flow-helpers.js` para entrar al Flow, `lib/llm-provider.js` para el LLM,
  `lib/cache-helpers.js` para la caché de respuestas, `lib/text-helpers.js` para
  extraer nombres de destinatarios, y escribe `state.json` al terminar.
  `--provider=claude|gemini` (default claude), `--dry-run` (mock local, sin API ni
  Chrome, útil para probar el pipeline sin gastar saldo).
- `lib/llm-provider.js` — `generate(provider, surveyText, systemPrompt, isDryRun)`:
  unifica las llamadas a Anthropic (`claude-sonnet-5`) y Gemini (`gemini-3.5-flash`)
  en un solo lugar. En `isDryRun` devuelve siempre el mismo texto mock, sin llamar a
  ninguna API — así `run.js` no necesita Chrome ni credenciales para probarse.
- `lib/cache-helpers.js` — caché local en `.cache/<hash-de-encuesta>.json` de
  respuestas del LLM que pasaron QA. Se salta por completo en `--dry-run` (nunca lee
  ni escribe) para que un test con mock no contamine la caché de una encuesta real.
- `lib/text-helpers.js` — `extractFirstNames(surveyText)`: extracción de nombres del
  destinatario filtrando palabras de relleno (mis/hijos/y/...). Único lugar donde
  vive esta lógica — la usan `run.js` y `verify-audio.js`, nunca duplicarla de nuevo
  (ver el bug multi-destinatario en LESSONS.md, que fue justo por tener esto duplicado).
- `suno-fill.js` — llenado de Suno (canónico; suno-fill2.js fue fusionado y borrado).
  Si un selector de la UI falla, cae a `pauseForHumanInteraction` en vez de matar
  el proceso — ver `lib/playwright-helpers.js`.
- `suno-create.js` — clickea Create manualmente (standalone; start-flow.js usa suno-create-dl.js)
- `suno-open-for-login.js` — Chrome standalone para login
- `flow-submit.js` — llenado de Título/Letra/Notas en el Flow (`#title`/`#lyrics`/`#notes`),
  nunca clickea Complete Song/Submit to QA. Mismo fallback interactivo que suno-fill.js.
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
- `upload-to-flow.js` — sube el MP3 elegido al Flow y guarda una copia de respaldo en
  `mp3/[Song ID] - [Título].mp3` (solo si el título de song.txt coincide con
  state.json). SE DETIENE sin Submit to QA (Regla Dura #1).
  Uso: `node upload-to-flow.js --version A|B` o `--file "ruta.mp3"`.
- `start-flow.js` — orquestador único. Modos:
  - `node start-flow.js` = flujo completo (genera, llena Suno, Create, descarga MP3,
    ESPERA a verify-audio.js con `--demucs`, llena Flow, muestra recomendación de
    versión y pregunta si subirla, corre upload-to-flow.js si confirmás, pregunta
    Submit to QA). Después de Submit manual, responde `s` a la pregunta final para
    cerrar automáticamente (o `start-flow.js --done` si la sesión se cortó antes).
  - `node start-flow.js --no-auto-create` = igual pero sin Create/descarga automáticos.
  - `node start-flow.js --no-auto-verify` = igual pero sin correr verify-audio.js
    (sin verify-report.json no hay recomendación ni auto-upload — todo queda manual).
  - `node start-flow.js --fast-verify` = el auto-verify usa Whisper small/CPU en vez de `--demucs`.
  - `node start-flow.js --done` = cierre: registra en la hoja + marca state.json.
  - `node start-flow.js --poll [N]` = vigía de cola (cada N min, default 3; acepta "30s").
  - `poll-flow.js` es ahora un redirect deprecated a `start-flow.js --poll`.
- `lib/suno-create-dl.js` — chequea créditos de Suno, Create × 1 (Suno v5.5 genera 2
  versiones por click), espera generación y descarga ambos MP3 a Downloads/suno/. Si
  falla clickear Download → MP3 Audio en la UI, cae a `pauseForHumanInteraction` en
  vez de tirar error — el watcher de filesystem y el fallback humano corren en
  paralelo (`Promise.race`), y el que pierde se cancela limpio (nunca queda un
  listener de stdin huérfano ni una promesa sin resolver).
- `lib/audio-match.js` — encuentra los 2 MP3 por título + recencia en Downloads/suno/.
- `lib/audio-analysis.js` — ffprobe (duración) + Whisper (transcripción) + comparación
  letra + `pickBestVersion(reportA, reportB)`: puntúa cada versión (duración, corte
  abrupto, clipping, fidelidad de letra, nombres ausentes, instrumental accidental) y
  recomienda una — siempre orientativo, nunca decide solo.
- `lib/transcribe.py` — script Python que usa faster-whisper para transcribir.
- `lib/ntfy.js` — notificaciones push vía ntfy.sh (tópico cancioneterna-gabo-2026).
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
