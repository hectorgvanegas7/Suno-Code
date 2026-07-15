# Canción Eterna — Pipeline de producción de canciones

## ════════════════════════════════════════════════════════════════════
## ✅ SUBMIT TO QA AUTOMÁTICO (Anti-Bot)
## ════════════════════════════════════════════════════════════════════
## El código AHORA SÍ hace click en "Submit to QA" o "Complete Song".
## - Se usa un algoritmo de randomización (ej. 26 a 31 min) para evitar
##   patrones robóticos que bloqueen la cuenta.
## - La Regla Dura #1 ha quedado deprecada oficialmente.
## ════════════════════════════════════════════════════════════════════

Pipeline para crear canciones cristianas personalizadas (negocio tipo SongFinch).
Esta carpeta es un repo git con remoto en GitHub (`origin/main`,
hectorgvanegas7/Suno-Code) — se usa para sincronizar entre la PC de Windows y
la Mac. Hacé commit (y push) antes de cambios grandes.

## Flujo completo (en orden)

`node start-flow.js` es el orquestador — corre todo esto como procesos hijo
reales. El flujo hoy es 100% automático (se sube sola la versión recomendada y
hace Submit to QA de forma automática tras un temporizador anti-bot aleatorio de 26-31 min).
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

2. **(opcional, no bloquea)** `song.txt` se abre en Notepad para que Gabo lo revise/edite
   si quiere — el proceso NO espera a que se cierre, sigue de largo solo.

3. **Suno** — `suno-fill.js` llena el formulario (título/letra/estilo/sliders).
   Si falla un selector de la UI, cae a un fallback interactivo (`pauseForHumanInteraction`
   en `lib/playwright-helpers.js`): pausa, avisa por ntfy con **botones de
   respuesta remota** (✅ continuar / 🛑 abandonar — se responde desde el
   celular sin ir a la PC, ver "Reply channel" abajo) y espera un ENTER en la
   terminal o la respuesta remota, en vez de matar el proceso. `start-flow.js` luego corre
   `lib/suno-create-dl.js` automáticamente: chequea créditos de Suno, verifica el
   formulario, clickea Create una vez (Suno v5.5 genera 2 versiones por click) y
   descarga ambos MP3 a `Downloads/suno/`. Con `--no-auto-create` se saltea este
   paso y Create + descarga quedan manuales.

4. **`verify-audio.js`** — corre automáticamente apenas aterrizan los 2 MP3 y
   **start-flow.js espera a que termine** (ya no es fire-and-forget en background)
   para poder leer su resultado. Analiza duración, Whisper, Levenshtein contra la
   letra, nombres de destinatarios ausentes, calidad perceptual con CLAP (claridad
   vocal, producción, emoción, artefactos, final), MOS de naturalidad de voz con
   NISQA (ruido, discontinuidad, coloración, volumen — señal complementaria a
   CLAP, más precisa para detectar voz robótica/con artefactos), nombres/palabras
   pegados sin pausa (`checkNamePacing`/`detectMergedWordPairs` en
   `lib/audio-analysis.js` — usa los word timestamps que Whisper ya devuelve, sin
   dependencia nueva; detecta el caso real reportado de "Clara tú" sonando como
   "Claratu" corrido) y (con `--demucs`,
   el default) separa voz y chequea instrumental accidental. Escribe `verify-report.json` con
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

7. **(automático)** Submit to QA se dispara solo entre el minuto 26 y 31
   (timer aleatorio anti-bot — la vieja Regla Dura #1 quedó derogada, ver
   sección al inicio de este archivo). Gabo puede clickearlo a mano antes si
   quiere, pero no hace falta. Si `state.json` marca `isRedo`, corre
   exactamente igual (pedido explícito de Hector 2026-07-09 — confía en la
   corrección automática de run.js según el feedback de QC).
   **GATE de upload (auditoría 2026-07-09):** el Auto-Submit solo dispara si
   en ESTA corrida se subió y confirmó un MP3 al Flow. Si el upload falló o
   nunca hubo MP3s (Create falló 3 veces, --resume sin archivos), NO se
   submitea — en un REDO eso re-mandaría a QA la versión VIEJA ya rechazada
   (redo sin cobrar). En ese caso avisa urgente por ntfy con los pasos
   manuales y la detección del Submit manual sigue activa igual.

8. **(automático)** Mientras tanto `start-flow.js` queda esperando SIN límite de
   tiempo (corta solo al detectar el Submit —propio o automático— o si Chrome
   se cierra; fallback: `--done`) y detecta el Submit solo. Muestra un
   **candado visual** en la pestaña de trabajo (badge rojo "🔒 AÚN NO" + botón
   Submit atenuado hasta el minuto 25, verde después — cosmético y fail-open:
   nunca clickea nada por sí solo, un F5 lo limpia, y se restaura al salir del
   loop). Al arrancar la espera hace un **pre-chequeo del botón "Submit to QA"**
   (solo verificación): si no está visible avisa por
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

9. **(automático)** Flow Screenshot ya queda pegado (imagen flotante vía
   `postImageToGallery`, ver Paso 8b) y Remarks queda vacío salvo REDO
   ("Redo Fix" automático) — confirmado 2026-07-09, no requiere intervención
   manual. Único fallback manual real que queda: si la extracción de tiempo
   falló (aviso en consola), Total Time y Time se llenan a mano.

## Reglas importantes

- **Protocolo de Co-Desarrollo (Antigravity & Claude Code)**:
  Ambos agentes operan sobre este mismo repositorio en paralelo. Para evitar pisarse:
  1. Correr `git status` y `git diff` antes de tocar cualquier archivo, y leer cambios sin commitear.
  2. Commitear inmediatamente los fixes validados con mensajes claros.
  3. NUNCA correr el pipeline vivo (`start-flow.js --loop`, etc.) mientras se edita código usado por el mismo.
  4. Documentar cada bug y fix en `LESSONS.md`.
  5. No reportar resultados de tests unitarios sin haberlos ejecutado en la sesión actual.
  6. Dejar notas en `LESSONS.md` (o `WORKING.md`) si se deja un fix a medias.
- **El tiempo se extrae automáticamente de "Recent completions"** cuando Chrome está
  abierto y el título coincide. Si falla, queda vacío para que Gabo lo llene a mano.
- **La verificación visual antes de Create NO es opcional** — ya atrapó defectos
  reales (ej. el bloque "Advertencias" colándose dentro de la letra). Nunca saltearla.
- **Checkpoints de verificación humana (opt-in)**: con `--pause`, start-flow.js
  pausa con ENTER (beep + ntfy) ANTES del Create de Suno y ANTES de subir el MP3
  al Flow. Por default NO pausan — el flujo entero, incluido el Submit, corre
  de un tirón sin ninguna interacción manual.
  `confirmToContinue` en `lib/playwright-helpers.js` (checkpoint amistoso)
  convive con `pauseForHumanInteraction` (fallback de emergencia) — no
  confundirlos.
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

## FACT_GATE — gate de hechos inventados (2026-07-14)

Env `FACT_GATE=off|warn|regen` (default **warn** = solo informativo, el modo
histórico). Con `regen`, un hecho sin respaldo en la encuesta (extracción
cerrada Haiku + comparación en código) dispara el mismo regen que el chequeo
N, dentro del presupuesto de 3 intentos (`decideFactGateAction` en
lib/ollama-guardia.js — pura; degrada a warn tras 2 regens por canción; la
señal caída jamás bloquea). **NO activar `regen` hasta que
`node guardia-benchmark.js --readiness` diga READY** (banco dorado ≥10 casos,
≥15 canciones reales, 0 falsos positivos confirmados). La calibración corre
sola: cada alarma informativa manda botones 🚨/❌ al celular y el watchdog
persiste los veredictos en `logs/fact-verdicts.jsonl`. Kill-switch:
`FACT_GATE=warn`. El smoke de API real (`node lib/preflight.js --with-api`,
una llamada Haiku mínima) corre automáticamente al arrancar `--loop` y lo
aborta con push urgente si la API está rota.

## Reply channel — responder pausas desde el celular (2026-07-14)

Toda pausa humana (`pauseForHumanInteraction` / `confirmToContinue`) ahora se
puede resolver de DOS formas: ENTER local en la terminal, o los **botones de
la notificación ntfy** en el celular (action `http` de la API JSON: cada botón
postea `<requestId>:<ok|abort>` al tópico de respuestas `REPLY_TOPIC` de
`lib/ntfy.js`, separado del principal para no generar eco). El pipeline pollea
ese tópico cada 15s (`waitForNtfyReply`) y solo acepta el nonce de la pausa
vigente (`parseReply`, puro y testeado). `ok` remoto = ENTER; `abort` remoto =
`HumanAbortError` (subclase de `HumanTimeoutError` a propósito: todos los
catch existentes ya tratan eso como "abandonar esta canción"). Las pausas con
evidencia visual adjuntan screenshots (`notifyAttachment`, PUT binario —
header `Filename` ASCII puro, jamás emoji en headers): el checkpoint
pre-Create manda los suno-verify-*.png y las pausas de upload los
flow-upload-*.png. La rama give-up del retry de Create ofrece por esta vía la
ÚNICA forma de autorizar un re-Create (gasta créditos) — nunca automático.
Si se cambia cualquiera de los dos tópicos: Hector tiene que re-suscribirse
en la app (solo al principal — el de respuestas no se suscribe) y hay que
anotarlo acá. Validado en vivo contra la API real el 2026-07-14 (ver
LESSONS.md).

## Archivos clave

- `run.js` — generación de letra (~900 líneas). Usa `lib/flow-helpers.js` para entrar
  al Flow, `lib/llm-provider.js` para el LLM, `lib/cache-helpers.js` para la caché de
  respuestas, `lib/text-helpers.js` para extraer nombres de destinatarios, y escribe
  `state.json` al terminar. `--provider=claude|gemini` (default claude), `--dry-run`
  (mock local, sin API ni Chrome, útil para probar el pipeline sin gastar saldo),
  `--force-regen` (2026-07-14: ignora la caché de letras y fuerza una llamada real
  al LLM — necesario para un redo intencional por CONTENIDO malo de una letra ya
  cacheada; borrar state.json a mano NO alcanza porque la caché se indexa por hash
  de la encuesta, que no cambió. `start-flow.js` lo reenvía tal cual a run.js).
- `lib/song-validate.js` — `hardValidate`, `validateContentForWrite`, `parseSections`,
  `extractField`: la validación estructural dura de la letra (movida desde `run.js` para
  poder testearla sin ejecutar el pipeline entero). Cubierta por
  `test/song-validate.test.js`, parte de la suite completa (`npm test`, 258 casos entre
  todos los `test/*.test.js`, 100% local sin API — incluye las regresiones reales de
  LESSONS.md: límites de palabra con tildes, N/A condicional, preámbulo antes de
  Título, símbolos no-✓ en el checklist, nombres multi-destinatario, respelling
  fonético, hash de song.txt, rotación de logs, parseo de sesión).
  ⚠️ Cada regla nueva del `SYSTEM_PROMPT` de `run.js` debe chequearse contra este
  validador Y agregarse un caso al test.
  También exporta `applyDeterministicLineFixes(letras, { firstNames })`
  (2026-07-13): correcciones SIN LLM que `run.js` corre inmediatamente
  después de cada `hardValidate()` fallido, ANTES del corrector barato de
  Haiku (`lib/song-corrector.js`) y antes de gastar un regen completo —
  tildes/eñes con única sustitución válida de diccionario
  (`applyDeterministicAccentFixes`), nombres españoles estándar sin tilde
  vía la ortografía canónica de la lista curada ("Jesus"->"Jesús", solo
  ocurrencias capitalizadas — el diccionario NO cubre 42/58 nombres
  acentuados en minúscula), puntuación prohibida (—;: -> coma) y
  dígitos->palabras para números sin problema de género/apócope (1-199 y
  años 1900-2099; terminados en 1 y 200+ van a Haiku). El chequeo M
  RECLASIFICA (nunca suprime) el typo de nombre sin tilde como fallo
  patcheable "Eñe/tilde perdida" con sección/línea — ver LESSONS.md
  2026-07-13 (dos entradas: el bug original de "Maria" y el agujero que
  abrió la primera versión del fix). El loop de generación además guarda
  el MEJOR candidato de los 3 intentos (no el último) y el parche de Haiku
  exitoso pasa por el mismo `runGrammarGate` que el camino valid normal.
  Con fallos de CONTENIDO sin resolver (`passedQA=false`), run.js PAUSA
  para revisión humana antes de Suno (LanguageTool caído no pausa — es
  red, no contenido).
  Chequeo N (2026-07-14, `findInventedProperNouns`): nombres propios
  INVENTADOS — un token capitalizado en MEDIO de una línea que no está en
  la encuesta (ni es término religioso de la regla 8, ni respelling
  fonético del destinatario vía levenshtein/name-dictionary) es un
  lugar/persona que el modelo inventó. Bug real ("El Hombre De Mi Vida":
  "nos cruzó por Miami" — la encuesta solo decía Cuba/Estados Unidos). NO
  parcheable a propósito: regen con contexto, y si persiste, la pausa
  pre-Suno existente. ⚠️ El Guardia NO cubre esto: verificado EN VIVO
  (2026-07-14) que qwen3:14b da fidelidad=10/aprobada=true a esa letra
  incluso con el prompt endurecido pidiendo chequeo hecho-por-hecho — la
  garantía vive acá, no en el prompt (mismo principio que "más de vos").
- `lib/spanish-spellcheck.js` — `findAccentTypos(text)`: chequeo GENERAL de
  tildes/eñes faltantes en cualquier palabra de la letra (no solo nombres
  propios), contra un diccionario real de español (`nspell` + `dictionary-es`,
  hunspell — deps reales en `package.json`, no listas a mano). Usado por la
  sección H2 de `hardValidate`. Bug real que lo originó (2026-07-11, "Fogata
  en la Arena"): "ano" en vez de "año", "pequena" en vez de "pequeña" — ver
  LESSONS.md para el diseño de 2 capas (palabra ya válida se deja pasar,
  si no es válida se prueban variantes con tilde/eñe) y el
  `ENYE_TYPOS_BLOCKLIST` chico que cubre homógrafos reales que el diccionario
  aceptaría sin más. Desde 2026-07-13 tiene DOS niveles: el normal
  (ano/montana/mama/jamas/ademas/ultimo/publico/medico — auto-corregibles
  sin LLM) y `ENYE_TYPOS_BLOCKLIST_CONTEXT` (papa/sueno — la forma sin
  tilde es PLAUSIBLE en una letra, "El Papa nos bendijo": se marcan con
  `needsContext: true` y solo Haiku los corrige, nunca el reemplazo
  determinístico). Agregar homógrafos nuevos al nivel que corresponda.
- `lib/languagetool-check.js` — `checkGrammarAndSpelling(sections, opts)`:
  Capa 2 de QA ortográfico/gramatical (2026-07-11, pedido explícito de
  Hector tras el mismo bug de "Fogata en la Arena": "que eso NUNCA FALLE").
  A diferencia de `spanish-spellcheck.js` (diccionario offline, no resuelve
  ambigüedad gramatical), llama a LanguageTool (`api.languagetool.org/v2/
  check`, gratis, sin API key — o `process.env.LANGUAGETOOL_URL` para
  apuntar a una instancia self-hosted en Docker más adelante, no instalada
  todavía) que SÍ entiende gramática real: "esta" (demostrativo) vs "está"
  (verbo estar) es el caso de manual que un diccionario nunca puede
  resolver. Solo las categorías `TYPOS`/`GRAMMAR`/`CONFUSIONS`/`DIACRITICS`
  cuentan como error duro — el resto queda informativo para no pelear con
  la licencia poética del SYSTEM_PROMPT. Filtra nombres/respellings
  fonéticos conocidos (`extractFirstNames`/`extractLyricNameVariants` de
  `lib/text-helpers.js` + `lib/name-dictionary.json`) antes de reportar,
  porque LanguageTool SÍ marca nombres como "Maryuri"/"Aandrea" como
  errores de ortografía si no se excluyen. Gate async nuevo en `run.js`
  (`runGrammarGate`), corre DESPUÉS de que `hardValidate` da `valid:true` —
  `hardValidate` se mantiene 100% síncrono/offline a propósito. Si
  LanguageTool no responde, la canción NO se asume limpia (nunca falla en
  silencio) — se marca para revisión manual sin gastar los 3 intentos de
  regeneración en un problema de red. Ver LESSONS.md para el detalle
  completo y la entrada de `lib/ollama-guardia.js` para la Capa 3.
- `lib/ollama-guardia.js` — `validarGuardia({ letras, titulo, survey })`:
  Capa 3 de QA de letra, "El Guardia" (2026-07-12). ⚠️ **MIGRADO de Ollama
  local a Claude Haiku el 2026-07-14** (nombre de archivo conservado por no
  romper imports) — YA NO ES GRATIS: cada llamada gasta créditos reales de
  `ANTHROPIC_API_KEY`, en cada canción, todas las pasadas. `--dry-run` por
  eso saltea el bloque entero del Guardia (antes lo corría igual porque
  Ollama no costaba nada). Bugs reales del día de la migración, arreglados
  y re-verificados EN VIVO (no solo con mocks — ver LESSONS.md): (1)
  `output_config.format` de Anthropic exige `additionalProperties: false`
  explícito en cada objeto del schema — sin esto, 400 silencioso, el
  Guardia nunca funcionó desde el primer commit; (2) Anthropic rechaza
  `minimum`/`maximum` en propiedades `integer` del schema (Ollama sí los
  toleraba) — el clamp a 1-10 se mantiene, pero ahora vive solo en
  `parseGuardiaResponse`, no en el schema. Modelo: `GUARDIA_MODEL` (env,
  debe ser un model ID de Anthropic válido — ej. `claude-haiku-4-5`; un
  nombre de Ollama como `qwen3:8b` rompe todas las llamadas en silencio).
  Juzga cómo está ARMADA la canción contra la encuesta real:
  coherencia/rima/tono/fidelidad/gancho (1-10) +
  `estiloCoincide` (¿el estiloSuno pedido —género/instrumentación/energía—
  tiene sentido para la ocasión de la encuesta? hardValidate solo chequea
  que incluya "seseo", nadie juzgaba el estilo en sí) + `problemas`
  ESTRUCTURADO (2026-07-13: antes strings libres, ahora `{ seccion, linea,
  tipo, gravedad, detalle }` — permite filtrar/cruzar por sección/tipo/
  gravedad contra hardValidate y el QA humano sin re-parsear texto;
  `formatGuardiaProblem(p)` arma el string legible para consola/notify;
  `parseGuardiaResponse` tolera el formato viejo de string suelto por si un
  modelo se desvía del schema) — lo que ni el diccionario ni LanguageTool
  pueden ver, y que antes solo se autoevaluaba el propio modelo generador.
  Corre en
  `run.js` SIEMPRE que haya letra Y no sea `--dry-run` (2026-07-13: antes se
  saltaba entero si `passedQA` era `false` tras agotar los 3 intentos de
  generación — justo la letra que más necesitaba una segunda opinión se
  quedaba sin ella). Diseño de pasadas (2026-07-13): pasada 1 CIEGA +
  pasada 2 INFORMADA (recibe `qaContext` con los fallos del QA duro y debe
  confirmarlos/descartarlos — antes eran idénticas y solo medían ruido de
  sampleo) + 3ra pasada de DESEMPATE si las dos discrepan en `aprobada`
  (mayoría decide la pausa; con una sola pasada disponible, esa decide).
  Nunca lanza — API caída o `ANTHROPIC_API_KEY` faltante = "sin señal esta
  vez": consola + `state.json` (`guardia`/`guardiaSegunda`/`guardiaDesempate`) +
  `logs/guardia-feedback.jsonl` (SIEMPRE se registra, incluso el fallo —
  con `passedQA`/`qaFailures`/`confianza`/`raw` para calibrar contra el QA
  humano) + ntfy si ninguna pasada estuvo disponible en una canción real.
  **Reprompt automático (2026-07-14):** si el Guardia marca problemas con
  sección+línea, `run.js` le pide un parche a `lib/song-corrector.js`
  (`patchSongLines`, gasta otra llamada a Haiku) y solo levanta el rechazo
  si `hardValidate` pasa Y —cuando el problema era de tipo `fidelidad`— la
  extracción de hechos se re-corre sobre el parche y sigue sin encontrar
  nada sin respaldo. Si la re-verificación falla, el parche se descarta
  entero y el rechazo original queda en pie (nunca se tapa un problema de
  fidelidad real solo porque la estructura quedó bien — ver LESSONS.md).
  `extraerHechosLetra({ letras, titulo })` + `compararHechosConEncuesta`
  (2026-07-14): extracción CERRADA de hechos — el modelo solo LISTA
  lugares/personas/fechas que la letra afirma (extraer es fácil; JUZGAR
  fidelidad no funciona: verificado en vivo que da fidelidad=10 a una letra
  con "Miami" inventado) y la comparación contra la encuesta se hace EN
  CÓDIGO (pura, testeada: dígitos de la encuesta expandidos a palabras —
  "13 de mayo" respalda "trece de mayo" —, whitelist religiosa, nombres).
  Corre en run.js tras la pasada 2 (modelo caliente, ~10-30s). INFORMATIVO
  hasta calibrar en el jsonl (`extraccionHechos`/`hechosSinRespaldo`);
  verificado en vivo: atrapa "Miami" en la letra mala real, CERO falsos
  positivos en la buena. Criterio de graduación: cuando el jsonl acumule
  casos sin falsos positivos sobre letras buenas, puede pasar a disparar
  regen automático (camino al 100% auto — complementa el chequeo N
  determinístico, que solo ve tokens Capitalizados mid-línea).
  Regla de comparación calibrada con el banco dorado (2026-07-14): tokens
  Capitalizados sin respaldo → flag; hechos en minúscula solo si contienen
  un dato TEMPORAL/NUMÉRICO sin respaldo (mes/día/número en palabras) —
  sustantivos comunes ("la casa", "la isla") son escenografía poética
  permitida por la regla 2 y NUNCA se marcan (falso positivo real atrapado
  por el banco). ⚠️ `think: true` NO arregla el juicio de fidelidad:
  verificado en vivo (145s de razonamiento) que igual da fidelidad=10 a la
  letra con "Miami" — no gastar más esfuerzo en prompts de juicio.
- `guardia-benchmark.js` — banco de casos DORADOS (`golden/<caso>/{song.txt,
  survey.txt, expect.json}`): mide chequeo N + extracción (+ `--judgment`
  opcional) contra letras reales ya etiquetadas buena/mala. `--offline` =
  solo chequeo N, sin red. Sale 1 si algo falla. **Correr tras CUALQUIER
  cambio de prompt/modelo del Guardia** — los prompts no se ajustan más "a
  ojo" (así se descubrió que el prompt endurecido de fidelidad no servía).
  Cada incidente real nuevo debe agregar su carpeta a `golden/`.
  ⚠️ Desde la migración a Haiku (2026-07-14): `--offline` sigue costando
  cero (solo chequeo N, sin red); la extracción y `--judgment` ahora SÍ
  gastan créditos reales de Haiku por caso — correrlo sin `--offline` ya no
  es gratis, tenerlo en cuenta antes de correr el banco entero seguido.
  `evaluarAudioGuardia({ titulo, letraPedida, transcripcion, señales,
  nombres })` (2026-07-13): mismo Guardia, ahora también como Capa 4 sobre
  AUDIO — lo llama `verify-audio.js` SIEMPRE, por cada versión (antes solo
  con alarma Levenshtein <75% / NISQA <50; se cambió porque un Levenshtein
  alto es compatible con el nombre mal cantado, y gateado por alarma nunca
  junta verdaderos negativos para calibrar). Caso real que lo motivó:
  ambas versiones de una canción marcaron "ALUCINACIÓN GRAVE"/NISQA ~23,
  pero el audio real estaba bien — Levenshtein no tolera adlibs de canto y
  NISQA nunca se calibró contra voz cantada. No puede escuchar el MP3,
  pero lee la transcripción de Whisper (ya generada, cero costo extra) y
  juzga SEMÁNTICAMENTE si coincide con la letra pedida — incluido
  `nombreCorrecto` (¿el nombre del destinatario se reconoce en lo
  cantado?, el error más caro del negocio) y `prioridadRevision` (2026-07-13:
  triage de fusión de señales — `verify-audio.js` le pasa TODAS las señales
  informativas del pipeline, no solo Levenshtein/NISQA/CLAP/missingNames
  como antes: loudness EBU R128, género de voz F0, palabras pegadas/
  cortadas, clipping, corte abrupto, MuQ-Eval, Audiobox. El Guardia cruza
  esas señales numéricas —que hoy viven aisladas cada una en su rincón del
  reporte— contra su propio juicio semántico y devuelve en una frase QUÉ
  conviene revisar de oído primero y por qué). Resultado en
  `report.guardiaAudio` / `verify-report.json`. PURAMENTE INFORMATIVO en
  general, pero start-flow.js SÍ lo usa como gate cuando ambas versiones
  fallan el umbral de fidelidad (pausa si el Guardia tampoco aprueba).
  Ver LESSONS.md.
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
- `lib/name-dictionary.json` — diccionario `{nombre en minúscula: respelling fonético}`
  para forzar la ortografía exacta de nombres difíciles ante Suno (ej. "maryuri":
  "Mariúri", "geovanny": "Yeováni"). `run.js` busca ahí cada nombre extraído con
  `extractFirstNames` ANTES de llamar al LLM; si hay coincidencia, inyecta una regla
  estricta en el mensaje (`🚨 REGLA ESTRICTA DE PRONUNCIACIÓN`) en vez de dejar que
  el modelo improvise el respelling. Costo cero cuando no hay match (no se toca el
  prompt). Cualquier entrada nueva que cambie la tilde de lugar hay que
  verificarla contra las reglas de acentuación española (sílaba tónica real del
  nombre) antes de agregarla — un par de entradas iniciales tenían la tilde en la
  sílaba equivocada (2026-07-05: "Yeóvani"→"Yeováni", "Aántoni"→"Aantóni",
  "Aalbert"→"Áalbert", "Máriuri"→"Mariúri") y solo se detectó en revisión manual,
  no con un test — no hay verificación automática de que un respelling "suene bien",
  eso sigue dependiendo de confirmarlo de oído contra Suno real. Este archivo,
  igual que el resto del SYSTEM_PROMPT, cae bajo la regla de mantenimiento de
  `lib/song-validate.js` — ver el test de `foneticaAplicada` + respelling con
  cambio de primera letra en `test/song-validate.test.js`.
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
- `lib/hygiene.js` — `rotateOldRunFiles()`: borra archivos de `logs/`,
  `screenshots/` y los clips de confirmación de oído (`Downloads/suno/
  name-check/` y `truncated-words/`) de más de 30 días, y recorta los `.jsonl`
  crecientes por cantidad de líneas. Se llama al final de un `start-flow.js
  --done` exitoso (best-effort, nunca lanza ni bloquea el cierre de la canción).
  **MP3s (2026-07-14, pedido de Hector — SSD lleno: Downloads/suno pesaba
  824M, mp3/ 367M):** dos retenciones DISTINTAS. `Downloads/suno/` (los
  archivos SUELTOS en la raíz, no las subcarpetas de arriba) se limpia a los
  `SUNO_WORKING_RETENTION_DAYS` (7 días) — son copias de TRABAJO, pura
  redundancia efímera. `mp3/` (el respaldo con Song ID de canciones YA
  ENTREGADAS a clientes, la única copia archivada) se limpia a los
  `RETENTION_DAYS` de siempre (30 días) — no se le bajó la retención porque
  es la fuente si algún día hay que reenviar un archivo.
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
  Antes de buscar el `input[type="file"]`, espera hasta 5s
  (`page.waitForSelector`) a que React lo monte — corre justo después de que
  flow-submit.js termina de escribir en la MISMA pestaña, y un chequeo
  inmediato podía dar 0 inputs por pura cuestión de timing (bug real, ver
  LESSONS.md). Si igual no aparece: 3 pasadas del cascade de selectores con
  esperas progresivas (0s/8s/15s — fallo real 2026-07-13, "La Pelota Que Se
  Soltó": una sola pasada dio 0 inputs y cayó directo al fallback manual) y,
  si sigue sin aparecer, screenshot de diagnóstico
  (`flow-upload-diagnosis.png`) ANTES del fallback, para que un fallo a las
  3 AM deje evidencia de cómo estaba la UI. NUNCA `page.reload()` acá: la
  pestaña tiene título/letra/notas recién llenados y no está verificado que
  el Flow los persista. El campo existe siempre, incluso en un REDO (dentro de la zona
  "Replace MP3", oculto pero interactuable) — no hace falta clickear
  "reemplazar" antes. La verificación final de que la subida funcionó compara
  el `src` del `<audio>` contra el que había ANTES de subir, no solo si existe
  alguno — en un REDO ya hay un `<audio>` con el archivo viejo rechazado por
  QC, así que "existe un audio" solo no prueba que la subida nueva funcionó.
  `exitAfterDelay` (250ms antes de `process.exit()`, mismo patrón que run.js)
  en todos los puntos de salida — evita un crash de libuv en Windows al
  cerrar una conexión CDP abierta.
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
    no hay reporte confiable), dispara el Submit to QA solo entre el min 26 y 31
    (timer anti-bot), y queda esperando SIN límite de tiempo a detectarlo —
    pestaña dedicada en background, título verificado contra state.json — para
    cerrar solo (Sheets + Drive, incluido el Flow Screenshot vía
    `postImageToGallery`). Fallback: `start-flow.js --done` si la sesión se
    cortó antes.
  - `node start-flow.js --no-auto-create` = igual pero sin Create/descarga automáticos.
  - `node start-flow.js --no-auto-verify` = igual pero sin correr verify-audio.js
    (sin verify-report.json no hay recomendación ni auto-upload — todo queda manual).
  - `node start-flow.js --fast-verify` = el auto-verify usa Whisper small/CPU en vez de `--demucs`.
  - `node start-flow.js --resume` = retoma un pipeline cortado a mitad de camino usando
    `state.json`: salta letra/Suno/Flow ya completados. Nunca re-clickea Create (evita
    gastar créditos doble) — si los MP3 no están en disco (ventana de 180 min), Create y
    descarga quedan manuales. Si `song.txt` no coincide con `state.json`, aborta con error
    en vez de mezclar canciones. Desde 2026-07-14 consulta primero los **intents
    write-ahead** (`interpretResume`): un Submit clickeado sin cierre registrado se
    VERIFICA en el Flow antes de tocar nada (jamás re-submit ciego — ver el bloque de
    intents más abajo). `--explain-resume` muestra la decisión sin ejecutar nada.
  - `node start-flow.js --dry-run` = ensayo completo sin gastar nada: run.js con
    mock local (cero API — valida contra la encuesta MOCK de
    `lib/llm-provider.js`, consistente con la respuesta mock, así el ensayo
    pasa la validación completa en vez de terminar siempre "con advertencia"),
    cero Chrome/Suno/Flow (simulados), pero ejercita DE VERDAD los checkpoints
    de ENTER y las notificaciones ntfy (marcadas [DRY-RUN]). Respalda song.txt
    antes y lo restaura SIEMPRE al final — el mock nunca pisa una canción real
    en curso. Tampoco flushea la cola de la galería (eso postearía de verdad;
    auditoría 2026-07-09).
  - `node start-flow.js --pause` = activa los 2 checkpoints de verificación
    humana (ENTER antes del Create de Suno y antes de subir el MP3 al Flow):
    pausan, hacen beep, avisan por ntfy y esperan ENTER. Por DEFAULT están
    DESACTIVADOS — el flujo normal no tiene ninguna interacción manual, ni
    siquiera el Submit (ver Auto-Submit más abajo).
  - `node start-flow.js --loop` = canciones en continuo: corre el flujo completo,
    Auto-Submit se dispara solo (26-31 min), cierra, y busca la siguiente (vigía
    si la cola está vacía). Un ciclo fallido avisa por ntfy y el loop sigue. En
    --loop el checkpoint pre-Create se saltea siempre (aunque haya --pause).
    `--loop --resume` retoma en el PRIMER ciclo lo que quedó a mitad (es lo
    que manda el watchdog al relanzar); los ciclos siguientes arrancan de
    cero. Ctrl+C apaga también el watchdog y borra el heartbeat (apagado
    limpio — nada "resucita" el pipeline después).
  - **Bulletproofing para dejarlo corriendo toda la noche** (2026-07-09):
    - `--loop` activa automáticamente un timeout de interacción humana de 20 min
      (`CANCIONETERNA_HUMAN_TIMEOUT_MS`, propagado por entorno a los scripts
      hijo) sobre `pauseForHumanInteraction`/`confirmToContinue`
      (`lib/playwright-helpers.js`): sin esto, un selector roto o créditos
      agotados trababa la cola ENTERA hasta que alguien apretara ENTER — ahora
      esa canción puntual se abandona (avisa urgente por ntfy) y el loop sigue
      con la próxima. Override manual: `--human-timeout=<minutos>` (0 =
      desactivar, volver a esperar para siempre incluso en --loop).
    - `lib/heartbeat.js` — `logs/heartbeat.json`. Late en TODAS las fases
      (rediseño auditoría 2026-07-09): los loops de poll y de espera del
      Submit lo escriben por tick, y `runFlow` entero corre bajo un **ticker
      por etapa** (`createStageHeartbeat`) que late cada 30s con un TECHO por
      etapa (preflight 5 min, run.js 25, suno-fill 25, create-descarga 45,
      flow-submit/upload 25, cierre 15 — siempre > el timeout humano de 20
      min, para que ese dispare primero). Si una etapa excede su techo, el
      ticker deja de latir A PROPÓSITO y el watchdog actúa — así "vivo y
      avanzando" y "colgado de verdad" siguen siendo distinguibles. Antes el
      heartbeat solo latía en 2 loops y el watchdog mataba pipelines SANOS a
      mitad de Create/descarga. Independiente de `state.json` (que solo
      cambia cuando avanza una canción). Al apagar `--loop` con Ctrl+C el
      heartbeat SE BORRA (`clearHeartbeat`) — un heartbeat viejo tirado hacía
      que el watchdog "resucitara" un pipeline apagado a propósito.
    - `watchdog.js` — supervisor EXTERNO, corre en su propio proceso (nunca
      comparte stdin con la terminal de start-flow.js). **`start-flow.js
      --loop` lo auto-arranca solo** — chequea `logs/watchdog.pid` para no
      duplicarlo (y el propio watchdog es singleton: si al arrancar ve otro
      vivo, sale); `--no-watchdog` lo desactiva. **Ctrl+C sobre `--loop` lo
      apaga también** (`stopWatchdogIfRunning`). Chequea cada 2 min si
      `logs/heartbeat.json` está viejo (>5 min); antes de matar VERIFICA que
      el PID sea un proceso de Node (`looksLikeNodeProcess` — Windows recicla
      PIDs, nunca taskkill a un proceso ajeno) y relanza `node start-flow.js
      --loop --resume` (el `--resume` se respeta en el primer ciclo del loop
      desde 2026-07-09 — antes se ignoraba). Tras relanzar REFRESCA el
      heartbeat con el PID nuevo (anti-cascada: sin eso, cada tick siguiente
      relanzaba OTRO pipeline en paralelo). Circuit breaker: 3 reinicios en
      30 min → frena y avisa urgente; el contador vive en
      `watchdog-state.json` Y en memoria (disco lleno no lo desactiva). La
      decisión matar/relanzar/frenar es pura y testeada (`decideAction`,
      test/watchdog.test.js). El resumen matutino no necesita Tarea
      Programada: cada tick chequea la hora y manda `sendDigest()` una vez
      por día pasadas las 7am — SOLO si el watchdog venía corriendo desde
      antes de esa hora (`shouldSendDigest`, testeada; un watchdog arrancado
      a las 23:00 ya no manda el "resumen matutino" en su primer tick).
      `node watchdog.js --digest` lo manda a mano. `logs/watchdog-events.jsonl`
      registra cada reinicio. El aviso de poco disco tiene cooldown de 1h (no
      spamea cada 2 min). No mata ni relanza Chrome — sigue vivo en el puerto
      9333 independiente de Node, `--resume` se reconecta a esa misma sesión.
    - `lib/preflight.js`: `checkDiskSpace()` (fs.statfsSync, sin dependencia
      nueva) — corre en el preflight inicial Y cada 30 min dentro del loop de
      poll, para agarrar disco lleno (Whisper/demucs/MP3s/logs) DURANTE la
      noche, no solo al arrancar.
  - Reintentos de Create/descarga SIN re-Create automático (rediseño
    2026-07-14 — la versión anterior re-clickeaba Create hasta 2 veces si la
    descarga fallaba, gastando créditos sin confirmación; contradecía la
    regla firme de Hector): la decisión vive en `decideCreateRetry`
    (lib/suno-create-dl.js, pura, testeada) sobre el **intent write-ahead**
    de state.json (`intents.create.clickedAt`, escrito ANTES del click
    físico). Fallo demostrablemente PRE-click (clickedAt ausente) →
    reintenta `createAndDownload` (seguro, no gastó nada). Fallo POST-click →
    reintenta SOLO la descarga con `downloadOnly()` (busca las 2 cards más
    recientes del título en la UI de Suno y las baja — jamás toca Create).
    3 intentos totales; al agotarlos avisa por ntfy `urgent` con los pasos
    manuales exactos según el caso (si Create ya se clickeó: "descargá de
    suno.com, NO vuelvas a crear").
    (Existió un `--max-rerolls N`/auto-reroll por mala pronunciación del
    nombre del destinatario — removido el 2026-07-04: la señal de "nombre
    ausente" de Whisper no era confiable y, visto en vivo, agotó los 2
    rerolls sin resolver nada, solo gastando créditos. Ver LESSONS.md.)
  - **Intents write-ahead en state.json** (auditoría de idempotencia
    2026-07-14): cada acción irreversible registra su intención ANTES de
    ejecutarla — `intents.create` (songId/requestedAt/clickedAt/downloadedAt,
    lib/suno-create-dl.js), `intents.submit` (clickedAt ANTES del click del
    Auto-Submit, confirmedAt tras el modal, start-flow.js) e `intents.upload`
    (verifiedAt SOLO tras ver el archivo en el DOM del Flow,
    upload-to-flow.js). `interpretResume` (lib/pipeline-state.js, pura,
    testeada) los interpreta en un `--resume`: Submit clickeado sin cierre →
    `resumeAfterSubmitIntent` verifica en "Recent completions" y JAMÁS
    re-llena/re-sube/re-submitea a ciegas (cierra con runDone si el Submit
    prendió; si es ambiguo avisa urgente y no toca nada). `startNew()` limpia
    los intents (canción nueva, pizarra limpia). Además `downloads` en
    state.json registra path+sha256 exactos de cada MP3 descargado:
    upload-to-flow.js sube ESE archivo (la búsqueda por título+recencia quedó
    como fallback con advertencia), y `uploadConfirmed` en start-flow.js ya
    NO se infiere del exit code — exige `intents.upload.verifiedAt` con el
    songId correcto. El Auto-Submit decide con `shouldAutoSubmit`
    (lib/flow-helpers.js, pura, testeada): bloquea por submit previo
    clickeado (doble Submit) o upload sin verificar.
  - `node start-flow.js --explain-resume` = solo lee state.json, explica qué
    haría un `--resume` (decisión de `interpretResume` + intents) y sale. Sin
    browser, sin red, sin escritura — para inspeccionar un estado dudoso
    antes de retomar.
  - Chequeo TEMPRANO de duración anómala post-descarga (2026-07-14): si
    AMBAS versiones salen MUY fuera de rango (`isDurationWildlyOff`,
    margen 1.5x sobre 2:45-3:30 — caso real "El Hombre De Mi Vida": 5:26 y
    5:36 con versos repetidos/loop), ntfy urgente + `pauseForHumanInteraction`
    apenas termina la descarga (ffprobe <1s), sin esperar los ~6 min del
    análisis completo (que sigue corriendo en paralelo mientras tanto).
    Decisión explícita de Hector: avisar+pausar, NUNCA re-clickear Create
    solo. En --loop la pausa expira a los 20 min y la canción se abandona
    sin subir nada. El chequeo vive FUERA del while de reintentos de Create
    a propósito — un timeout de la pausa jamás debe re-clickear Create.
    verify-audio.js corre el mismo chequeo como aviso temprano informativo.
  - `node start-flow.js --done` = cierre: registra en la hoja + marca state.json.
  - `node start-flow.js --poll [N]` = vigía de cola. Default: intervalo aleatorio
    10-15s. Acepta minutos ("3"), segundos ("30s") o rangos ("10-15s", "1-2").
    Reusa el Chrome del puerto 9333 si ya está abierto (no lanza ventana propia).
    Si el flujo normal arranca sin canciones en cola, cae solo a este modo.
    `pollOnce` recarga (`page.reload()`) la pestaña reutilizada en CADA poll —
    bug real (2026-07-04, ver LESSONS.md): sin esto, tras una cola vacía la
    pestaña quedaba abierta con el DOM viejo para siempre, y el poller nunca
    detectaba una canción nueva que cayera después.
  - `poll-flow.js` es ahora un redirect deprecated a `start-flow.js --poll`.
  - Cada corrida (normal o `--poll`) escribe toda su salida — la propia + la de cada
    script hijo (`run.js`, `suno-fill.js`, `flow-submit.js`, `upload-to-flow.js`) — en
    `logs/run-<timestamp>.log`, además de mostrarla en la terminal como siempre. El
    auto-verify en background sigue con su log aparte (`logs/verify-audio-auto-*.log`).
- `lib/suno-create-dl.js` — chequea créditos de Suno, Create × 1 (Suno v5.5 genera 2
  versiones por click), espera generación y descarga ambos MP3 a Downloads/suno/.
  **Mecanismo real de descarga** (doc corregida en auditoría 2026-07-09 — la
  versión anterior de este bloque afirmaba `saveAs()` "de punta a punta" y
  A/B "en paralelo", que el código nunca tuvo; ya lo había detectado LESSONS
  2026-07-07 #3): `clickDownloadMp3` clickea ⋯ → Download → MP3 Audio con el
  listener de `page.on('download')` re-armado en CADA intento de click (Suno
  tarda 2.6-6.3s en preparar el archivo, medido en vivo); el evento nativo
  CONFIRMA que arrancó y `download.failure()` espera el final (techo 8 min),
  pero el archivo se localiza con `findDownloadedFile` (título + mtime,
  contrato en test/find-downloaded-file.test.js) y `renameSync` inmediato.
  El loop A→B es SECUENCIAL a propósito: el rename inmediato de A evita que
  la búsqueda por título de B agarre el archivo equivocado. Si falla clickear
  automáticamente, cae a `pauseForHumanInteraction` — un click humano en
  "MP3 Audio" dispara el mismo evento nativo, así que se detecta igual.
- `lib/audio-match.js` — encuentra los 2 MP3 por título + recencia en Downloads/suno/.
  `titleMatchScore` ignora palabras ≤2 caracteres por defecto, pero si eso deja
  la lista vacía (título compuesto enteramente por palabras cortas, ej. "Fe",
  "A ti") usa todas las palabras sin filtrar en vez de dar 0 siempre (bug real,
  ver LESSONS.md).
- `lib/audio-analysis.js` — ffprobe (duración) + Whisper (transcripción) + comparación
  letra + CLAP (calidad perceptual: claridad vocal, producción, emoción, artefactos,
  final — ±15 pts informativo, no decide solo) + NISQA (MOS de naturalidad de voz:
  ruido, discontinuidad, coloración, volumen — ±10 pts, más conservador que CLAP
  hasta validarlo en vivo, no decide solo) + `pickBestVersion(reportA, reportB)`:
  puntúa cada versión (duración, corte abrupto, clipping, fidelidad de letra, nombres
  ausentes, instrumental accidental, CLAP, NISQA) y recomienda una — siempre orientativo,
  nunca decide solo.
  `verifyNamePronunciation`: segunda opinión sobre la pronunciación del nombre del
  destinatario. La transcripción principal corre con `initial_prompt`=letra completa
  (modo `--demucs`) para evitar alucinaciones, pero eso sesga a Whisper a "escuchar"
  la palabra esperada aunque el audio real tenga un sonido espurio (ver LESSONS.md).
  Para cada nombre que SÍ se dio por presente, recorta (ffmpeg) la ventana de tiempo
  de esa palabra y la re-transcribe SIN pista — si la segunda pasada no confirma el
  nombre, lo marca en `report.nameAudioChecks` (informativo, no cambia `missingNames`)
  y deja el clip de ~1-2s en `<carpeta del mp3>/name-check/` para confirmar de oído
  en segundos en vez de la canción entera. Pesa ±15 pts en `pickBestVersion`, igual
  filosofía que CLAP (señal nueva, no decide sola).
  `checkNamePacing`/`detectMergedWordPairs`: detectan palabras pegadas sin pausa
  (ej. "Clara tú" cantado como "Claratu" corrido — bug real reportado por Gabo
  2026-07-04) midiendo el hueco entre los word timestamps que Whisper ya
  devuelve (sin dependencia nueva). `checkNamePacing` corre por cada nombre de
  destinatario confirmado presente y deja un clip en `name-check/` (mismo
  mecanismo que `verifyNamePronunciation`); pesa ±15 pts en `pickBestVersion`
  (señal determinística, mismo peso que `nameAudioChecks`).
  `detectMergedWordPairs` escanea toda la letra en busca del mismo problema
  fuera de los nombres — puramente informativo (`report.pacingIssues`, 0 pts)
  hasta confirmar con casos reales que el umbral no genera ruido. Los
  umbrales (`NAME_GAP_MERGE_THRESHOLD_S`/`GENERAL_GAP_MERGE_THRESHOLD_S`) son
  un primer valor sin calibrar contra oído humano — `verify-audio.js` appendea
  cada caso detectado a `logs/pacing-feedback.jsonl` para ajustarlos más
  adelante con casos reales (esto es un log para calibración manual, NO un
  sistema de entrenamiento de un modelo).
  `detectTruncatedWords` (2026-07-09, pedido real de Hector; rediseñada en la
  auditoría del mismo día): distinto de "nombre ausente" (la palabra no se
  canta) y de "pegadas" (dos palabras sin hueco) — acá la palabra SÍ se canta
  pero Suno la corta antes de terminarla (ej. "Fran-" en vez de "Frank").
  Gate primario: probability baja de Whisper (<0.55) — OJO, en `--demucs` la
  transcripción corre con `initial_prompt`=letra, que INFLA la confianza en
  las palabras esperadas (sesgo documentado en LESSONS.md 2026-07-04), así
  que las candidatas son pocas y medirlas es barato (cap explícito de 15,
  logueado si se excede — nunca trunca en silencio). Confirmación: duración
  muy por debajo de la esperada por vocales (`countVowelsEs` × 0.09s,
  `tooShort`) O caída de volumen >8dB entre la primera y la segunda mitad de
  la palabra (ffmpeg, misma técnica que `detectAbruptCutoff`). El diseño
  original exigía tooShort para siquiera medir — y era ciego al caso que
  motivó la señal: "Fran-" conserva su vocal cantada larga, la duración casi
  no cambia; lo que delata el corte es la caída de volumen. Cada entrada
  reporta ambos booleanos (`tooShort`, `volumeDropConfirmed`) para calibrar.
  `report.truncatedWords` (también en verify-report.json), puramente
  informativo (0 pts en `pickBestVersion`) hasta calibrar en vivo — guarda un
  clip de ~0.5-1s por candidata en `truncated-words/` para confirmar de oído,
  mismo mecanismo que `name-check/` (ambas carpetas rotan a 30 días vía
  `lib/hygiene.js` desde 2026-07-09).
- `lib/transcribe.py` — script Python que usa faster-whisper para transcribir.
- `lib/clap_score.py` — script Python que evalúa calidad de audio con CLAP (modelo
  laion/clap-htsat-unfused). Recibe 1+ MP3, devuelve JSON con score 0-100 global y
  5 dimensiones. 100% local, cero API de nube. Sigue el mismo patrón que
  transcribe.py (batching, CUDA fallback, JSON a stdout). Requiere:
  `pip install transformers librosa` (torch ya está para Whisper). Degrada con
  gracia si no está instalado.
- `lib/nisqa_score.py` — script Python que evalúa MOS de naturalidad de voz con
  NISQA v2.0 vía `torchmetrics.audio.NonIntrusiveSpeechQualityAssessment` (pesos
  pre-entrenados, se descargan solos la primera vez). Recibe 1+ audios (idealmente
  la voz ya aislada por demucs — ver `resolveVocalOrMixPaths` en
  `lib/audio-analysis.js`, compartida con CLAP para no duplicar el criterio de
  "qué archivo representa la voz de esta versión"), devuelve JSON con
  `nisqa_score` 0-100 (MOS normalizado) + 4 dimensiones (ruido, discontinuidad,
  coloración, volumen). Mismo patrón que clap_score.py (batching, CUDA fallback,
  JSON a stdout, fail-fast de dependencias). Requiere: `pip install torchmetrics`
  (ya instalado 2026-07-08; torch/librosa ya estaban). Degrada con gracia si no
  está instalado. Señal complementaria a CLAP: entrenado específicamente para
  MOS de voz, más preciso que la similitud texto-audio de CLAP para detectar
  voz robótica/con artefactos.
- `lib/muq_eval_score.py` — script Python que evalúa calidad musical percibida
  con MuQ-Eval (arXiv 2603.22677: head liviano sobre el encoder MuQ-310M
  congelado, entrenado contra ratings de expertos en MusicEval; checkpoint A1
  auto-descarga de HF `zhudi2825/MuQ-Eval-A1`). OJO calibración: el SRCC
  0.957 del paper es a nivel SISTEMA — por clip individual (como lo usa este
  pipeline) es 0.838. Recibe 1+ audios (el MIX completo, no la voz aislada —
  la calidad musical es propiedad de la mezcla entera), trocea en ventanas de
  10s a 24kHz y devuelve JSON con `score` 1-5 (media) + `score_std` + `n_clips`.
  Mismo patrón que clap_score.py (batching, CUDA fallback, JSON a stdout,
  fail-fast). Requiere el repo clonado (NO es pip-instalable):
  `git clone https://github.com/dgtql/MuQ-Eval` + `pip install -r
  MuQ-Eval/requirements.txt` + `setx MUQ_EVAL_DIR "<carpeta>"`. Degrada con
  gracia si falta. Wrapper `runMuqEvalScore` en `lib/audio-analysis.js`;
  PURAMENTE INFORMATIVO (0 pts en `pickBestVersion`) hasta calibrar en vivo —
  cada corrida queda en `logs/audio-quality-feedback.jsonl` para eso.
- `lib/audiobox_score.py` — script Python que evalúa calidad de producción con
  Meta Audiobox Aesthetics (`pip install audiobox_aesthetics`, checkpoint se
  auto-descarga). Devuelve JSON con 4 ejes ~1-10: `pq` (Production Quality, el
  titular), `pc` (Complexity), `ce` (Enjoyment), `cu` (Usefulness) — se
  reportan los 4 para calibración gratis. Mismo patrón/mismo estado
  informativo que muq_eval_score.py (wrapper `runAudioboxScore`, sobre el MIX
  completo, 0 pts en `pickBestVersion`, log en
  `logs/audio-quality-feedback.jsonl`). Ambos scores corren SECUENCIALES
  en verify-audio.js (spawnSync ya es bloqueante): cada proceso carga su
  modelo, puntúa y muere liberando VRAM — nunca compiten por los 8GB con
  Whisper/demucs/CLAP/NISQA. Además de verify-report.json, las señales se
  anotan en `state.json` (`muqEval`/`audiobox`) SOLO si el título del state
  coincide con el analizado (verify-audio standalone sobre MP3s viejos no
  debe pisar el estado de la canción en curso).
- `checkLoudness` (en `lib/audio-analysis.js`) — loudness EBU R128 (filtro
  `ebur128` de ffmpeg, cero dependencia nueva): loudness integrado (LUFS),
  rango de loudness (LU) y true peak (dBFS). `report.loudness`, puramente
  INFORMATIVO (0 pts en `pickBestVersion`) hasta calibrarlo contra casos
  reales de Suno — mismo criterio que `detectMergedWordPairs` general. Flag
  de referencia si el integrado cae fuera de [-28, -8] LUFS (fuera de eso es
  candidato a sonar muy bajo o muy comprimido/fuerte, sin validar en vivo
  todavía).
- `lib/f0_gender_check.py` — estima F0 (frecuencia fundamental) con
  `librosa.pyin` (CPU, sin modelo nuevo — librosa ya es requisito de
  clap_score.py) y clasifica género de voz cantada (Femenina >= 175 Hz,
  Masculina <= 160 Hz, 160-175 Hz zona ambigua a propósito = Indeterminado).
  Wrapper `runF0GenderCheck` en `lib/audio-analysis.js`, mismo patrón de
  graceful degrade que CLAP/NISQA. **Corre SOLO sobre la voz aislada por
  demucs** (auditoría 2026-07-09): sin aislar, pyin sobre la mezcla la
  dominan bajo/instrumentos y el "género detectado" es ruido con apariencia
  de dato — en modo rápido (sin --demucs) la señal se salta con un error
  explícito en vez de reportar basura. `report.f0Gender` (también en
  verify-report.json) compara contra el campo `voz` de song.txt
  (`expectedGender`, pasado desde `verify-audio.js`) y marca `mismatch` si no
  coinciden — PURAMENTE INFORMATIVO (0 pts en `pickBestVersion`), no
  calibrado en vivo todavía.
- `lib/ntfy.js` — notificaciones push vía ntfy.sh, publicadas con la **API
  JSON** (POST a la raíz, tópico en el body). NUNCA volver a mandar el título
  como header HTTP: fetch() de Node exige headers Latin-1 y cualquier emoji
  en el título tiraba TypeError silencioso — las notificaciones críticas
  (watchdog 🛑/🔄, timeout humano ⏱️, digest 🌙) jamás llegaron al celular
  hasta el fix del 2026-07-09 (bug real, ver LESSONS.md; regresión fijada en
  test/ntfy.test.js). Un envío fallido ahora deja una línea en consola/log en
  vez de tragarse el error 100% mudo. Tópico privado con sufijo aleatorio
  (ntfy.sh no tiene auth — un nombre adivinable deja leer/mandar
  notificaciones a cualquiera). Si el tópico cambia otra vez, avisar: hay que
  re-suscribirse en la app.
  **Mapa de notificaciones del flujo normal** (para saber qué esperar en el
  celular por cada canción de noche): "Canción Asignada" → (si algo requiere
  humano: "🚨/✋" con timeout visible) → "✅ Tiempo Seguro (25m)" → "🤖 Submit
  enviado" (o "🛑 Auto-Submit bloqueado" si no hay MP3 subido — urgente, con
  pasos manuales) → "✅ Canción cerrada — <título>" con fila y pendientes.
  A la mañana: "🌙 Resumen de la noche" (submits ok/fallidos/bloqueados,
  reinicios del watchdog, disco), con "✅ Noche limpia" arriba si no hay nada
  que mirar.
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
- `download-click-diagnosis.js` — script standalone de diagnóstico (10 clicks de
  prueba en cards YA generadas — nunca clickea Create, cero créditos gastados)
  que mide cuánto tarda Chrome en confirmar (`page.on('download')`) el inicio
  de una descarga tras clickear "MP3 Audio". Corré `node download-click-
  diagnosis.js` si vuelve a sospecharse un timeout de descarga — guarda
  `download-click-diagnosis-report.md` (gitignored, foto de un momento).
  Originado por Antigravity (2026-07-04): confirmó que Suno tarda 2.6-6.3s en
  preparar el archivo, el dato que llevó a la migración completa a
  `download.saveAs()` en `lib/suno-create-dl.js` (ver LESSONS.md).
- `sheets.js` — wrapper standalone de `lib/sheets-core.js` (registro en Google Sheet)
- `lib/playwright-helpers.js` — helpers de Playwright (clickByText, setSliderValue,
  expandIfCollapsed, connectToSunoTab, isLoggedIn). Además:
  - `isPortUp(port)` — chequeo de puerto CDP antes de lanzar o conectar
    Chrome, para fallar con un mensaje claro en vez de un stack trace feo.
    `run.js` lo usa para decidir si lanza el Chrome compartido del 9333 o se
    conecta al existente; `flow-submit.js`, `suno-fill.js` y
    `upload-to-flow.js` lo usan al revés (avisan si Suno NO está abierto
    antes de conectarse). (`ensurePortIsFree` ya no existe — doc corregida
    2026-07-09: el pipeline entero comparte UNA instancia en el 9333.)
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
