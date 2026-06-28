# Canción Eterna — Pipeline de producción de canciones

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

3. **Suno** — `suno-fill.js` conecta por CDP a un Chrome en el puerto 9333, llena
   suno.com/create (modo Advanced) con título/letra/estilo desde `song.txt`,
   setea Vocal Gender según "Voz:", sliders Weirdness/Style Influence a 55%, y
   toma screenshots para verificación visual. `suno-create.js` clickea Create dos
   veces (solo DESPUÉS de que Gabo confirme los screenshots). `suno-open-for-login.js`
   abre Chrome standalone con el puerto de debug para logins manuales.
   `start-flow.js` (o `npm run flow`) encadena run.js + login check + suno-fill.js +
   flow-submit.js.

4. **`flow-submit.js`** — conecta por CDP al mismo Chrome (puerto 9333), abre/reabre
   la tab del Flow si hace falta, y llena Título/Letra/Notas del Flow desde `song.txt`
   (campos `#title`, `#lyrics`, `#notes`). Toma `flow-submit-verify.png` y se detiene.
   Nunca clickea "Complete Song"/Submit to QA, nunca cierra Chrome. `start-flow.js` lo
   corre como paso 4/4, después de `suno-fill.js`.

5. **(manual)** Gabo escucha las 2 versiones de Suno, elige, descarga el MP3, lo sube
   al Flow (ya con título/letra/notas llenos) y hace Submit to QA / Complete Song.

6. **`node start-flow.js --done`** (o `node sheets.js`) — Lee `song.txt`, extrae
   Título + Song ID, elige el tab mensual más reciente del Google Sheet (ej.
   "JULY 2026", no usa el mes del calendario), y llena la primera fila vacía con
   Date/Total Songs=1/Title/Song ID. Tiene anti-duplicados (no reescribe un Song
   ID ya presente) y solo toca las columnas A,B,E,F — nunca C ni D (tiempo). El
   modo `--done` además marca state.json como completado. Deja vacío para Gabo:
   Total Time, Time, Remarks, Screenshot.

7. **(manual)** Gabo llena Total Time + Time + Remarks + pega Flow Screenshot.

## Reglas importantes

- **El tiempo lo llena Gabo siempre, a mano.** Se paga por hora, el tiempo en el
  Flow incluye margen (~20-25 min mínimo por canción). El script nunca lo toca.
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
- `suno-create.js` — clickea Create (después de verificación visual)
- `suno-open-for-login.js` — Chrome standalone para login
- `flow-submit.js` — llenado de Título/Letra/Notas en el Flow (`#title`/`#lyrics`/`#notes`),
  nunca clickea Complete Song/Submit to QA
- `start-flow.js` — orquestador único. `node start-flow.js` = flujo completo hasta el
  checkpoint visual. `node start-flow.js --done` = cierre (registra en la hoja + marca
  state.json como completado), se corre DESPUÉS de subir el MP3.
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
