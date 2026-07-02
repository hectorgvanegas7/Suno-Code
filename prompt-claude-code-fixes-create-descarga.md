# Prompt para Claude Code — Fixes de Create + descarga MP3 + prueba de start-flow

Copiá TODO lo de abajo y pegalo en Claude Code desde
`C:\Users\hecto\automation\cancioneterna-flow\`.

---

Lee CLAUDE.md y LESSONS.md COMPLETOS antes de hacer cualquier cosa. Si existe
AUDITORIA-fase1.md, leelo también — tiene el diagnóstico detallado de estos bugs.

## REGLAS DURAS — NO NEGOCIABLES (verificá cada una antes de cada cambio)

- NUNCA hagas click en "Submit to QA" ni "Complete Song", ni agregues código que
  lo haga. Regla Dura #1 de CLAUDE.md.
- NUNCA automatices la elección de versión A/B. verify-audio INFORMA, no decide.
- NO cierres Chrome bajo ninguna circunstancia. Conectá por CDP y desconectá
  (browser.close() sobre conexión CDP solo desconecta — eso está bien).
- NO corras run.js ni start-flow.js mientras haya una sesión de Suno abierta en
  el puerto 9333 que yo esté usando. Preguntame antes de cualquier corrida.
- NO hagas git push. Commits locales sí, uno por fix, con mensaje claro.
- NO toques la lógica de extracción de nombres de hardValidate en run.js.
- Trabajá UN FIX A LA VEZ: mostrame el diff, esperá mi OK explícito, aplicá,
  commit. Nunca agrupes varios fixes en un solo cambio.
- Antes de arrancar: `git add -A && git commit` de lo que haya sin commitear
  (hay cambios pendientes en lib/suno-create-dl.js y suno-create.js) con mensaje
  "snapshot antes de fixes create+descarga". Así cualquier fix se puede revertir.

## CONTEXTO DE LOS BUGS (evidencia real, no hipótesis)

En la última corrida real de `node start-flow.js` (canción "Tu Corazón Sin
Fronteras") pasó esto:

1. **Create se clickeó 2 veces y se generaron canciones de más.** Suno v5.5
   ahora genera 2 VERSIONES POR UN SOLO CLICK en Create. El doble click era el
   diseño correcto para la versión vieja de Suno; hoy crea 4 canciones y quema
   créditos. Evidencia: en el workspace aparecen cards duplicadas de más por
   canción.

2. **La descarga falló para A y B con "El submenú no mostró MP3 Audio".** Causa
   raíz (confirmada con screenshot del menú real): "Download" en el menú ⋯ es un
   SUBTRIGGER de submenú de Radix (flecha ▸) — se abre con HOVER, no con click.
   Clickearlo puede cerrar el menú entero. El flyout muestra: "MP3 Audio",
   "WAV Audio (Pro)", "Get Stems (Pro)", "Video (Pro)". Hay que clickear
   SOLO "MP3 Audio" — NUNCA WAV, NUNCA nada con "Pro".
   Además, tras clickear "MP3 Audio", Suno muestra un toast "preparing your
   mp3... may take a few seconds" — la descarga NO empieza inmediatamente, hay
   preparación server-side. El watcher de filesystem tiene que estar corriendo
   desde ANTES del click y con deadline generoso (el actual de 8 min está bien).

3. **Watcher huérfano pisando la terminal.** Cuando la descarga falló, el
   watcher de `watchForNewMp3` quedó vivo imprimiendo "⏳ Esperando MP3..."
   cada 30s durante 8 minutos, mezclándose con el prompt interactivo
   "¿Ya hiciste Submit to QA? (s/n)". El watcher no se cancela cuando el flujo
   de descarga falla antes de que el archivo aterrice.

**Dato clave:** existe un archivo `suno-create-dl.js` SUELTO EN LA RAÍZ del
proyecto (untracked). Es un borrador anterior que YA CONTIENE los fixes de
descarga (hover + estados de retorno + watcher cancelable + piso de estabilidad)
pero le falta el fix del selector de Create por aria-label que sí está en
`lib/suno-create-dl.js` (commit 846a20d, ver la entrada más nueva de LESSONS.md).
NO reemplaces el archivo de lib con el de la raíz — portá las funciones buenas
de la raíz hacia lib, conservando el selector `button[aria-label="Create song"]`
de lib. Ojo con line endings: la raíz es LF, lib es CRLF — mantené el estilo de
lib al editar.

## FIXES A APLICAR (en este orden, uno por uno, diff + mi OK antes de cada uno)

### FIX 1 — Create se clickea UNA SOLA VEZ (Suno v5.5 genera 2 versiones por click)

En `lib/suno-create-dl.js` (`createAndDownload`):
- Eliminar TODO el bloque del segundo click ("Click #2 en Create", su
  `ensureCreateClickable`, su `safeClick`, y el `waitForFunction` de "esperar a
  que el botón vuelva a estar activo").
- Un solo click en Create debe producir 2 cards nuevas. Después del click #1
  confirmado, esperar hasta ~20s a que aparezcan HASTA 2 hrefs nuevos
  (`/song/<uuid>` que no estén en el snapshot `existingHrefs`) — la 2da card
  puede aparecer un instante después de la 1ra. Si a los 20s solo hay 1,
  continuar con 1 versión (log de advertencia), como hoy.
- Guardia anti-desperdicio: si aparecen MÁS de 2 cards nuevas, loguear
  advertencia fuerte (significa que algo clickeó de más) pero procesar solo las
  2 primeras.
- Actualizar el comentario de GARANTÍAS del header del archivo: dice "Nunca
  clickea más de 2 veces en Create" → debe decir "Clickea Create UNA SOLA VEZ
  (Suno v5.5 genera 2 versiones por click)".

También en `suno-create.js` (el fallback manual standalone): dejarlo en UN solo
click, mismo motivo.

Y actualizar CLAUDE.md donde dice "clickea Create × 2".

### FIX 2 — Descarga por HOVER del submenú Radix (portar de la raíz)

Portar desde `./suno-create-dl.js` (raíz) hacia `lib/suno-create-dl.js` la
función `tryOpenDownloadMp3(page, href, label)` COMPLETA, con su contrato:
- Escape + 200ms para cerrar cualquier menú previo.
- Localizar la card por href (como ya hace lib), abrir el ⋯ con safeClick.
- "Download": localizar por role menuitem / texto exacto, y ABRIRLO CON
  `hover()` (hasta 3 intentos de hover con 500ms entre cada uno; como red de
  seguridad en el último intento, probar un click en el subtrigger).
- Poll de hasta ~3s extra por la opción "MP3 Audio" visible, re-hovereando el
  subtrigger entre polls para mantener el flyout abierto.
- Salvaguarda: si el item elegido matchea /wav|lossless/i y no /mp3/i, NO
  clickear (Escape y devolver 'not-ready').
- Click final en "MP3 Audio": hover primero (mete el pointer en el flyout),
  150ms, luego click con timeout 4s y fallback a click force.
- Retornos: 'clicked' (se clickeó MP3 Audio), 'not-ready' (el menú abrió pero
  MP3 Audio no apareció — reintentable), 'no-menu' (no está la card o el ⋯ —
  estructural).

Y reescribir `downloadVia3DotMenu(page, href, label, sunoDir, destPath,
deadlineMs = DOWNLOAD_WAIT_TIMEOUT_MS)` para que:
- Arranque el watcher ANTES de tocar el menú (ya lo hace — conservar).
- Loopee llamando `tryOpenDownloadMp3` hasta el deadline: 'clicked' → salir del
  loop y esperar el archivo; 'not-ready' → log con segundos transcurridos +
  esperar 5s + reintentar (cubre el toast "preparing your mp3" y renders
  tardíos); 'no-menu' → reintentar hasta 3 veces con 2s, después error claro.
- Si nada clickeó al deadline → error descriptivo.

La versión de la raíz ya tiene todo esto implementado — usala como referencia
literal, adaptando solo estilo/line-endings de lib.

### FIX 3 — Watcher cancelable (nunca más huérfano imprimiendo sobre la terminal)

Portar de la raíz el cambio de `watchForNewMp3` para que devuelva
`{ promise, cancel }` en vez de una Promise pelada:
- `cancel()` cierra fs.watch + timers y RESUELVE con null (no rechaza) — así un
  watcher abandonado jamás produce unhandled rejection ni sigue logueando.
- En `downloadVia3DotMenu`, envolver todo en try/catch y llamar
  `watcher.cancel()` en el catch antes de relanzar el error.
- Si `watcher.promise` resuelve null (cancelado), tratarlo como fallo con
  mensaje claro.
- Verificar que el log de progreso de 30s ("⏳ Esperando MP3...") muere junto
  con el cancel — ese es exactamente el log que me pisó el prompt de
  "¿Ya hiciste Submit to QA?" en la corrida real.

### FIX 4 — Piso de estabilidad en waitForGeneration (portar de la raíz)

Portar las tres constantes y su lógica:
- `MIN_READY_DURATION_SEC = 45` — una card generando muestra "0:00" que matchea
  `/^\d+:\d{2}$/`; nuestras canciones duran 2:45–3:30, cualquier duración menor
  al piso es placeholder.
- En `scanClipRows`: tomar la MAYOR duración mm:ss encontrada en la card (no la
  primera), agregar detección de "generando" por texto
  (/creating|generating|queued|pending|loading|\d+\s*%/i) y por
  `[aria-busy="true"]`/`[class*="pulse"]` además del spinner actual.
  `ready` = duración real ≥ piso Y sin señales de generación.
- `MIN_GENERATION_FLOOR_MS = 20000` — nunca declarar "generadas" antes de 20s
  desde el click, diga lo que diga el DOM.
- `STABILITY_POLLS = 2` — una card cuenta como lista solo si aparece "ready"
  con la MISMA duración en 2 escaneos consecutivos.

IMPORTANTE: al portar, conservá los selectores actuales de lib
(`button[aria-label="Create song"]` en createBtn, jsClickCreate y el chequeo de
habilitado con data-disabled). La raíz tiene la versión vieja del selector
(/create/i genérico) — NO la traigas, ese regex está documentado como bug en la
entrada más nueva de LESSONS.md.

### FIX 5 — Borrar el archivo huérfano de la raíz

Solo DESPUÉS de que los fixes 2-4 estén portados, verificados y commiteados:
borrar `./suno-create-dl.js` (raíz). Es un borrador que require('./audio-match')
con paths que solo resuelven desde lib/ — no puede ni ejecutarse desde donde
está, y tener dos copias es cómo llegamos a este merge pendiente.

### FIX 6 — Documentar en LESSONS.md

Una entrada nueva arriba de todo, estilo de las existentes, cubriendo:
- Suno v5.5: 1 click = 2 versiones (el doble click generaba 4 canciones).
- Submenú Download de Radix se abre con hover, no click; toast "preparing your
  mp3" = la descarga tarda en arrancar tras el click.
- Watcher huérfano: cualquier watcher/timer de fondo debe ser cancelable y
  cancelarse en el catch del flujo que lo creó.

## PRUEBA (después de que TODOS los fixes tengan mi OK y estén commiteados)

Etapa A — SIN gastar créditos ni canciones:
En el workspace de Suno ya hay cards TERMINADAS de corridas anteriores
("Tu Corazón Sin Fronteras", "El Hombre Que Elegí"). Antes de una corrida
completa, armá un mini-script temporal (o usá node -e) que conecte al Chrome
del 9333 y ejecute SOLO `downloadVia3DotMenu` contra el href de una de esas
cards existentes, descargando a un archivo de prueba. Eso valida el fix de
hover + watcher con cero costo. AVISAME antes de correrlo (yo tengo que tener
la sesión de Suno abierta y no estar usándola). Borrá el script temporal y el
MP3 de prueba después.

Etapa B — corrida real completa:
Solo cuando yo te diga que hay una canción real para procesar y que no estoy
usando la sesión de Suno: corré `node start-flow.js` y monitoreá que:
1. Create se clickea UNA vez y aparecen exactamente 2 cards nuevas.
2. waitForGeneration no declara listo antes de ~20s ni con "0:00".
3. Ambos MP3 aterrizan en Downloads/suno/ con sufijos -A y -B.
4. verify-audio arranca solo en background y su log queda en logs/.
5. El Flow queda lleno (título/letra/notas) y el script SE DETIENE antes de
   Submit to QA, con el prompt interactivo LIMPIO (sin logs de watcher encima).
Yo hago la escucha, la elección A/B, el upload y el Submit — como siempre.

Si algo falla en la Etapa B, NO improvises fixes sobre la marcha: frenás,
me mostrás el log y el screenshot diagnóstico, y decidimos juntos.
