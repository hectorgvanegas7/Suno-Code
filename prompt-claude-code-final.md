# Tarea: ampliar el pipeline de cancioneterna-flow con descarga + análisis de audio + cierre asistido

Vamos a extender el pipeline que YA FUNCIONA. El objetivo es máxima calidad y
seguridad, no velocidad. Todo lo nuevo debe ser ADITIVO: si algo nuevo falla,
el pipeline existente debe seguir funcionando exactamente como hoy. El usuario
SIEMPRE revisa al final. Elegir qué versión suena mejor es y seguirá siendo
100% manual y humano — nada de esto la reemplaza.

═══════════════════════════════════════════════════════════════════════
🛑 REGLA DURA #1 — NO NEGOCIABLE: NUNCA hacer "Submit to QA"
═══════════════════════════════════════════════════════════════════════
El código JAMÁS, bajo NINGÚN motivo, hace click en "Submit to QA" en el Flow.
- El script SÍ sube el MP3 elegido al campo de archivo del Flow.
- Inmediatamente después se DETIENE e imprime:
  "✅ MP3 subido al Flow. Escuchá/revisá y hacé Submit to QA vos cuando estés conforme."
- NO es un flag configurable. NO hay default que lo active. Es restricción de diseño.
- El usuario necesita poder cambiar su elección si al re-escuchar no le convence,
  ANTES de que quede enviado. Un submit automático le costaría un redo sin pago.
- Poné un comentario en bloque grande e imposible de ignorar justo donde termina
  la subida del archivo, prohibiendo automatizar el Submit en cualquier refactor
  futuro. Documentalo en CLAUDE.md en su propia sección destacada.
- Si identificás el selector del botón Submit to QA, es SOLO para garantizar que
  NUNCA se clickee por accidente (ej. selector ambiguo). No lo uses para actuar.

═══════════════════════════════════════════════════════════════════════
🛑 REGLA DURA #2 — NO ROMPER LO QUE YA FUNCIONA
═══════════════════════════════════════════════════════════════════════
El pipeline actual (start-flow.js, run.js, suno-fill.js, lib/*, sheets-core.js,
poll-flow.js) está operativo. Antes de tocar nada:
- Leé CLAUDE.md y LESSONS.md completos.
- Hacé un commit o backup del estado actual ANTES de empezar, para poder revertir.
- Cada pieza nueva va en su PROPIO módulo/archivo nuevo cuando sea posible, en vez
  de reescribir los existentes. Si tenés que tocar un archivo existente, tocá lo
  mínimo y dejá el comportamiento viejo intacto si la pieza nueva está apagada.
- NO toques las columnas A/B/E/F del registro de la hoja (ya funcionan). NUNCA
  escribas en C/D automáticamente sin confirmación del usuario.
- NO reintroduzcas `networkidle` en ningún lado (ya lo sacamos; causaba timeouts
  porque Suno/Flow tienen websockets constantes). Usá `domcontentloaded` +
  `waitForSelector` por una señal concreta del DOM. Verificá con
  `grep -rn networkidle .` que sigue en cero al terminar.
- Respetá la regla de puertos: poller usa 9334, run.js usa launchPersistentContext
  con el mismo perfil, suno-fill usa CDP 9333 — NUNCA dos procesos sobre el mismo
  puerto/perfil a la vez. Si tu pieza nueva abre Chrome, reusá la conexión CDP
  existente, no abras una segunda instancia en conflicto.
- Cualquier contenido lazy-loaded (React/fetch) necesita una señal concreta del
  DOM antes de leerlo, nunca un sleep fijo ni asumir presencia por otro elemento.

═══════════════════════════════════════════════════════════════════════
PIEZA 1 — Carpeta dedicada Downloads/suno/ para descargas de Suno
═══════════════════════════════════════════════════════════════════════
- Crear (si no existe) la carpeta `suno` dentro de la carpeta Downloads real del
  usuario. ⚠️ Detectar la ruta REAL de Downloads: en algunos Windows OneDrive la
  redirige, no asumas C:\Users\hecto\Downloads. Verificá que existe y es escribible.
- Configurar la sesión de Chrome (vía CDP/Playwright, Page.setDownloadBehavior o
  el contexto de Playwright) para que TODAS las descargas de Suno caigan en
  Downloads/suno/, no en Downloads general.
- De ahora en adelante todo MP3 de Suno vive ahí. El análisis solo mira esa carpeta.

Errores a manejar: carpeta no creable por permisos; ruta de Downloads no estándar;
la config de descarga de Chrome no se aplica vía CDP (probar y, si no, fallback a
mover el archivo desde Downloads general a /suno tras detectarlo).

═══════════════════════════════════════════════════════════════════════
PIEZA 2 — Automatizar "Create" en Suno
═══════════════════════════════════════════════════════════════════════
Hoy el usuario clickea Create a mano tras el llenado. Pasa a ser automático.
- Tras llenar el formulario (título/letra/estilo/voz/sliders 55%), el script
  clickea Create solo. El usuario YA confirmó que quiere esto automático.
- ANTES de clickear, reusar la verificación visual por screenshot que ya existe
  (esa que atrapó el bloque de Advertencias colándose en la letra). Si la
  verificación visual detecta algo raro en el formulario, NO clickear Create y
  avisar. La verificación visual previa a Create NO es opcional.

Errores a manejar: botón Create no presente / deshabilitado (créditos agotados,
campo faltante) → avisar claro, no reintentar a ciegas; Suno muestra modal de
error/limite → detectarlo y reportar; doble click accidental → guardas para no
crear dos veces.

═══════════════════════════════════════════════════════════════════════
PIEZA 3 — Esperar generación y descargar AMBOS MP3 a Downloads/suno/
═══════════════════════════════════════════════════════════════════════
Suno genera 2 versiones; tarda varios minutos.
- Esperar a que AMBAS versiones terminen de generar usando una señal concreta del
  DOM (botón/opción de download habilitada, estado "complete"), NUNCA networkidle
  ni sleep fijo. Poné un timeout generoso (ej. varios minutos) con mensaje claro
  si se excede.
- Descargar AMBAS como MP3 (NUNCA WAV) a Downloads/suno/.
- Confirmar que los 2 archivos .mp3 realmente aterrizaron (existen, tamaño > 0, no
  .crdownload a medias) antes de continuar.

Errores a manejar: una versión falla y la otra no → descargar la que esté y avisar
cuál falta; descarga colgada / archivo a medias → esperar o reintentar una vez;
Suno cambió el flujo de descarga (menú distinto) → detectar y reportar en vez de
clickear a ciegas; formato exportado no es MP3 → abortar esa descarga y avisar.

═══════════════════════════════════════════════════════════════════════
PIEZA 4 — Verificar que se analiza la canción CORRECTA (match por título)
═══════════════════════════════════════════════════════════════════════
Antes de analizar, asegurarse de que los MP3 corresponden a ESTA canción y no a
una sesión anterior.
- Tomar el título de la canción actual desde song.txt (o el estado del pipeline).
- Matchear contra los archivos de Downloads/suno/: por nombre de archivo (Suno
  suele nombrar el archivo con el título) Y por fecha de modificación reciente
  (últimos N minutos, default 15, configurable).
- Elegir los 2 MP3 que correspondan a este título y sean recientes → Versión A / B.
- IMPRIMIR los nombres + timestamps de los 2 elegidos para verificación visual
  humana antes de analizar.
- Si el título del archivo NO matchea el de song.txt, o no hay 2 recientes que
  correspondan → AVISAR y NO analizar. Mejor frenar que analizar la canción
  equivocada.

Errores a manejar: Suno nombró el archivo distinto al título (normalizar:
minúsculas, sin tildes, sin puntuación, comparar por similaridad, no exact match);
títulos muy cortos/genéricos que matchean de más; archivos viejos de otra canción
con título parecido → la combinación título + reciente lo cubre, pero si hay duda,
preguntar/frenar.

═══════════════════════════════════════════════════════════════════════
PIEZA 5 — Instalar/verificar Whisper local + ffmpeg
═══════════════════════════════════════════════════════════════════════
- Instalar Python (si falta), faster-whisper y ffmpeg. Usar venv local en el
  proyecto si no hay permisos globales de pip.
- Verificar cada uno con un check real (transcribir un audio corto; `ffprobe -version`).
  Si algo no queda funcionando, abortar SOLO esta pieza con mensaje claro; el resto
  del pipeline sigue.
- Modelo: probar `small` o `medium` en español priorizando precisión en NOMBRES
  propios; documentar cuál quedó. CPU está bien (solo más lento).

Errores: Python ausente/incompatible; pip sin permisos → venv; ffmpeg no en PATH →
usar ruta absoluta; descarga del modelo falla por red → reintentar y avisar.

═══════════════════════════════════════════════════════════════════════
PIEZA 6 — Análisis de ambas versiones (INFORMA, no decide)
═══════════════════════════════════════════════════════════════════════
Sobre cada MP3:
1. Duración (ffprobe): ✓ si 2:45–3:30, ⚠️ si no.
2. Transcripción Whisper → comparar contra song.txt:
   - Marcar diferencias de letra, foco en el NOMBRE del dedicado (mispronunciación).
   - Reportar timestamps aproximados de las discrepancias para guiar la escucha.
   - Normalizar antes de comparar (minúsculas/sin tildes/sin puntuación) y usar
     similaridad por línea, no exact match, para tolerar el ruido de Whisper.
3. Título cantado: marcar ⚠️ si el título literal aparece en lo transcripto (no debe).

Salida final clara, tipo:
```
🎵 Canción: <título>
Versión A (archivo.mp3): 3:12 ✓ | letra coincide ✓ | título no cantado ✓ → SIN PROBLEMAS
Versión B (archivo.mp3): 2:38 ⚠️ fuera de rango | nombre mal pronunciado ~1:45 ⚠️ → REVISAR
👉 Estas marcas son ORIENTATIVAS. Confirmá siempre con tu oído.
```

Reglas de seguridad: NUNCA elige versión, NUNCA sube nada, NUNCA toca QA. Whisper
sobre canto da falsos positivos → dejarlo MUY explícito en la salida. Si Whisper
falla en un archivo, reportar la duración igual y seguir; no abortar todo.

Errores: MP3 corrupto → reportar y saltar; transcripción vacía/basura → "no
confiable", no comparar; song.txt ausente → solo duración + aviso.

═══════════════════════════════════════════════════════════════════════
PIEZA 7 — Subir el MP3 elegido al Flow (SIN submit — ver Regla Dura #1)
═══════════════════════════════════════════════════════════════════════
- El usuario elige una versión (manual). El script sube ESE MP3 al campo de
  archivo del Flow (page.setInputFiles o equivalente).
- Verificar que el archivo quedó cargado (nombre visible en el campo) antes de
  detenerse.
- SE DETIENE. NO hace Submit to QA (Regla Dura #1). Imprime el aviso para que el
  usuario revise y haga submit manual.

Errores: campo de archivo no encontrado → avisar; archivo rechazado por formato/
tamaño → avisar; subida no confirmada en el DOM → no asumir éxito, avisar.

═══════════════════════════════════════════════════════════════════════
PIEZA 8 — Screenshot del Flow → insertar en la hoja (con fallback a manual)
═══════════════════════════════════════════════════════════════════════
El screenshot de "Recent Completions" ya se captura (pieza existente, no la rompas).
Lo nuevo: meter esa imagen en la columna de screenshot de la hoja.
⚠️ La Sheets API NO inserta imágenes embebidas en celda directamente. Investigá la
vía real en este setup:
  - Opción A: subir el PNG a Drive con el service account, obtener link visible,
    poner =IMAGE("link") en la celda.
  - Opción B: si el service account no tiene permiso de Drive (muy posible), NO
    forzar: dejar el PNG guardado local con nombre claro y AVISAR para pegarlo a
    mano. Las columnas A/B/E/F deben quedar intactas pase lo que pase.
Probalo de verdad, no asumas que A funciona.

═══════════════════════════════════════════════════════════════════════
PIEZA 9 — Remark draft automático (se MUESTRA, no se escribe solo)
═══════════════════════════════════════════════════════════════════════
- Generar borrador de remark leyendo las advertencias del validador/banner QC.
  Ej: "Destinatario sin nombre propio, apertura genérica." / "Sin novedades."
- MOSTRARLO en consola para que el usuario lo confirme/edite. NO escribirlo solo
  en la columna Remarks.

Errores: sin advertencias → "Sin novedades."; no se puede leer el validador →
draft vacío + aviso, no romper.

═══════════════════════════════════════════════════════════════════════
INTEGRACIÓN, ORDEN Y SALVAGUARDAS GENERALES
═══════════════════════════════════════════════════════════════════════
- Piezas 2–3 (Create + descarga) corren como continuación del llenado en Suno.
- Piezas 4–6 (match + análisis) corren después, idealmente como comando propio
  (ej. `node verify-audio.js`) que el usuario lanza cuando ya tiene los 2 MP3.
- Pieza 7 (subir al Flow) corre cuando el usuario ya eligió versión.
- Piezas 8–9 se integran en el cierre (--done) respetando A/B/E/F automáticas y
  C/D asistidas-pero-confirmadas.
- Agregá flags para poder apagar cada pieza nueva individualmente, así si una
  rompe algo el usuario puede volver al flujo viejo al instante.
- Logueá cada paso con claridad (qué archivo, qué versión, qué resultado) para
  poder debuggear desde el celular vía Chrome Remote Desktop.
- Notificá vía ntfy.sh (tópico cancioneterna-gabo-2026) cuando el análisis
  termine, así el usuario sabe que ya puede escuchar.
- Actualizá CLAUDE.md (incluida la sección destacada de Regla Dura #1) y
  documentá todo bug/aprendizaje en LESSONS.md.

═══════════════════════════════════════════════════════════════════════
CRITERIO DE ACEPTACIÓN
═══════════════════════════════════════════════════════════════════════
- El flujo viejo sigue corriendo igual con las piezas nuevas apagadas.
- Descargas de Suno caen en Downloads/suno/.
- Create se clickea solo tras verificación visual OK.
- Ambos MP3 se descargan, se matchean por título contra song.txt, y se analizan.
- El análisis informa cuál tiene problemas y cuál no, sin elegir ni subir nada.
- El MP3 elegido se sube al Flow y el script SE DETIENE sin hacer Submit to QA.
- Si Whisper/ffmpeg/Drive/descarga fallan, el sistema avisa y cae a manual sin
  romper nada ni corromper la hoja.
- `grep -rn networkidle .` sigue en cero.
- El usuario sigue decidiendo todo lo estético, el Submit to QA y la confirmación
  de remark/screenshot.
