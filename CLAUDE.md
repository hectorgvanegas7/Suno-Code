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

1. **`node run.js`** — Abre el Artist Flow de cancioneterna.com, entra al Flow,
   resuelve la asignación activa (o asigna la más urgente). Lee la encuesta,
   genera letra + estilo Suno + título via API de Anthropic (Sonnet 4.6, system
   prompt y checklist QA están dentro de run.js). Guarda en `song.txt` y lo abre
   en Notepad. Maneja REDO automáticamente: si hay banner naranja de QC, lee el
   feedback + letra actual y pide a Claude el fix preciso + una pasada de mejora
   a 9-10/10, en vez de generar desde cero. NO escribe en los campos del Flow.

2. **(manual)** Gabo revisa/edita `song.txt`.

3. **Suno** — `suno-fill.js` llena el formulario (título/letra/estilo/sliders).
   `start-flow.js` luego corre `lib/suno-create-dl.js` automáticamente: verifica
   el formulario, clickea Create × 2, espera la generación (~2-4 min) y descarga
   ambos MP3 a `Downloads/suno/`. Con `--no-auto-create` se saltea este paso y
   Create + descarga quedan manuales. Notifica vía ntfy cuando los MP3 están listos.

4. **`flow-submit.js`** — llena Título/Letra/Notas en el Flow. Toma screenshot.
   Nunca clickea Submit to QA (ver Regla Dura #1).

5. **`node verify-audio.js`** — analiza los 2 MP3 (duración + Whisper). INFORMA,
   no decide. Necesita `node setup-whisper.js` corrido una vez antes.

6. **(manual)** Gabo escucha las 2 versiones, elige.

7. **`node upload-to-flow.js --version A|B`** — sube el MP3 elegido al Flow.
   SE DETIENE (Regla Dura #1). Nunca hace Submit to QA.

8. **(manual)** Gabo hace Submit to QA en el Flow.

6. **(automático al final de `node start-flow.js`)** — Después de completar el
   Paso 4/4, el proceso pausa y pregunta `¿Ya hiciste Submit to QA? (s/n)`. Al
   responder `s`, corre automáticamente la lógica de cierre: conecta al Chrome del
   puerto 9333, navega a `/artists/flow/create`, lee la primera card de "Recent
   completions", verifica que el título coincida con state.json, extrae el tiempo de
   sesión (ej. "26 min session" → Time="00:26", Total Time=0.43) y toma un screenshot
   recortado de la card (→ `screenshots/YYYY-MM-DD_slug.png`). Luego lee `song.txt`,
   elige el tab mensual más reciente del Google Sheet (ej. "JULY 2026") y llena la
   primera fila vacía con Date(A)/Total Songs=1(B)/Total Time(C)/Time(D)/Title(E)/
   Song ID(F). Si la extracción de tiempo falla (Chrome cerrado, título no coincide,
   etc.) se loguea un aviso y se continúa sin C ni D — anti-duplicados siempre activo.
   Marca state.json como completado. **`node start-flow.js --done`** (o `node sheets.js`)
   queda como fallback si la sesión se cerró antes de responder.

7. **(manual)** Gabo llena Remarks + pega Flow Screenshot. Si el tiempo no se pudo
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

- `run.js` — generación de letra (~850 líneas, validación estructural dura adentro).
  Usa `lib/flow-helpers.js` para entrar al Flow y escribe `state.json` al terminar.
- `suno-fill.js` — llenado de Suno (canónico; suno-fill2.js fue fusionado y borrado)
- `suno-create.js` — clickea Create manualmente (standalone; start-flow.js usa suno-create-dl.js)
- `suno-open-for-login.js` — Chrome standalone para login
- `flow-submit.js` — llenado de Título/Letra/Notas en el Flow (`#title`/`#lyrics`/`#notes`),
  nunca clickea Complete Song/Submit to QA
- `setup-whisper.js` — instala/verifica Python, faster-whisper, ffmpeg. Correr una vez.
- `verify-audio.js` — analiza los 2 MP3 (duración + Whisper + comparación letra). INFORMA,
  no decide, no sube nada. Requiere setup-whisper.js previo.
- `upload-to-flow.js` — sube el MP3 elegido al Flow. SE DETIENE sin Submit to QA (Regla Dura #1).
  Uso: `node upload-to-flow.js --version A|B` o `--file "ruta.mp3"`.
- `start-flow.js` — orquestador único. Cuatro modos:
  - `node start-flow.js` = flujo completo (genera, llena Suno, Create, descarga MP3, llena Flow).
    Después: verify-audio.js → upload-to-flow.js → Submit manual → start-flow.js --done.
  - `node start-flow.js --no-auto-create` = igual pero sin Create/descarga automáticos.
  - `node start-flow.js --done` = cierre: registra en la hoja + marca state.json.
  - `node start-flow.js --poll [N]` = vigía de cola (cada N min, default 3; acepta "30s").
  - `poll-flow.js` es ahora un redirect deprecated a `start-flow.js --poll`.
- `lib/suno-create-dl.js` — Create × 2 + espera generación + descarga ambos MP3 a Downloads/suno/.
- `lib/audio-match.js` — encuentra los 2 MP3 por título + recencia en Downloads/suno/.
- `lib/audio-analysis.js` — ffprobe (duración) + Whisper (transcripción) + comparación letra.
- `lib/transcribe.py` — script Python que usa faster-whisper para transcribir.
- `lib/ntfy.js` — notificaciones push vía ntfy.sh (tópico cancioneterna-gabo-2026).
- `sheets.js` — wrapper standalone de `lib/sheets-core.js` (registro en Google Sheet)
- `lib/playwright-helpers.js` — helpers de Playwright (clickByText, setSliderValue,
  expandIfCollapsed, connectToSunoTab, isLoggedIn)
- `lib/flow-helpers.js` — `enterFlowAndEnsureAssignment`: lógica COMPARTIDA para entrar
  al Flow y garantizar asignación activa (Enter Flow + Assign Most Urgent Song + retry).
  La usan run.js Y start-flow.js, así no divergen (ver bug del 2026-06-28 en LESSONS.md).
- `lib/pipeline-state.js` — `state.json`: rastrea Song ID + título + etapa actual entre
  scripts, para detectar si se está por procesar la canción equivocada.
- `lib/sheets-core.js` — lógica de registro en la hoja, importable (la usa sheets.js y
  el modo --done de start-flow).
- `lib/preflight.js` — health-check (API key, credenciales, deps) antes de arrancar.
- `song.txt` — salida de run.js. Formato: bloque **Título:**/**Voz:**/**Trato:**/
  **Estilo Suno:**, luego `---`, las 6 secciones [Verse 1] etc, opcionalmente
  **Advertencias:**, y al final línea `NOTES:` con el Song ID. Cualquier parser de
  "solo la letra" debe cortar en lo que venga primero: **Advertencias:** o NOTES:.
- `survey.txt` — encuesta cruda leída del Flow
- `state.json` — estado del pipeline (lo escribe run.js, lo leen los demás). Efímero.
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
