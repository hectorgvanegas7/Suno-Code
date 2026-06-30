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
- `suno-create.js` — clickea Create (después de verificación visual)
- `suno-open-for-login.js` — Chrome standalone para login
- `flow-submit.js` — llenado de Título/Letra/Notas en el Flow (`#title`/`#lyrics`/`#notes`),
  nunca clickea Complete Song/Submit to QA
- `start-flow.js` — orquestador único. Tres modos:
  - `node start-flow.js` = flujo completo: genera letra, llena Suno, llena el Flow,
    luego pausa y pregunta `¿Ya hiciste Submit to QA? (s/n)`. Al responder `s`,
    registra en la hoja automáticamente en el mismo proceso — sin abrir otra terminal.
  - `node start-flow.js --done` = cierre manual (fallback si la sesión se cerró
    antes de responder al prompt). Registra en la hoja + marca state.json.
  - `node start-flow.js --poll [N]` = vigía de cola: abre Chrome en puerto 9334, verifica
    cada N minutos (default 3; acepta "30s" para segundos). Al encontrar canción, cierra su
    Chrome (espera señal concreta: puerto caído), luego arranca el flujo completo en el mismo
    proceso. Detecta typos de `--done`/`--poll` escritos con espacio y aborta antes de hacer daño.
  - `poll-flow.js` es ahora un redirect deprecated a `start-flow.js --poll`.
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
