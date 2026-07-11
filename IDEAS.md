# Ideas de Optimización y Mejoras Futuras
Este archivo recopila propuestas de arquitectura, robustez y ahorro de costos para el pipeline de automatización.

## 1. Control de Costos y Tokens (Prioritario)
*   **Caché Local de Respuestas de Claude/Gemini (Cost-Saving Cache):**
    *   *Detalle:* Almacenar localmente un archivo `.cache/<hash-de-survey>.json` con la respuesta exitosa del LLM. Si el script de Playwright se cae más adelante (ej. en la descarga de Suno), al reintentar se leerá la caché local, previniendo gastos de regeneración.
*   **Checkpoint de Caché en el Self-Correction Loop:**
    *   *Detalle:* Configurar los parámetros de Anthropic para cachear la historia de mensajes del bucle de corrección en vez de volver a enviar todo el prompt del sistema y la respuesta fallida entera a precio completo.

## 1b. QA ortográfico/gramatical — Capa 3 (proofreading LLM independiente)
*   **Contexto:** ya existen 2 capas reales (2026-07-11): `lib/spanish-spellcheck.js` (diccionario offline, dentro de `hardValidate`) y `lib/languagetool-check.js` (gramática/ortografía real vía LanguageTool, gate async en `run.js`). Ver LESSONS.md.
*   **Detalle:** un tercer pase, opcional y NO implementado todavía, con un modelo barato (Haiku) INDEPENDIENTE del que generó la letra, cuyo único trabajo sea proofreading (nunca estilo/contenido) — pensado para casos semánticos que ni un diccionario ni LanguageTool pueden atrapar (una palabra real, bien escrita, pero mal elegida en contexto). Deliberadamente no se construyó junto con las otras 2 capas — hay que calibrar esas primero en producción antes de agregar una tercera capa (mismo criterio que ya usa este repo para CLAP/NISQA/loudness: "informativo hasta calibrar en vivo", no sumar señales sin datos reales de cuánto aportan).

## 2. Simplificación y Arquitectura
*   **Unificación de run.js y run-gemini.js:**
    *   *Detalle:* Fusionar la lógica en un solo archivo `run.js` y utilizar flags como `node run.js --gemini` o variables de entorno (`PROVIDER=gemini`) para alternar el modelo, evitando la desincronización de las reglas de validación en `hardValidate`.
*   **Diagnóstico previo de la Encuesta (Pre-flight Survey Validation):**
    *   *Detalle:* Analizar el archivo `survey.txt` localmente antes de llamar a las APIs. Si faltan campos clave (ej. destinatario vacío, trato inconsistente en la respuesta), alertar antes de gastar tokens.

## 3. Robustez en Navegación (Playwright / Chrome)
*   **Detección Previa de Puertos CDP Bloqueados:**
    *   *Detalle:* Realizar una conexión TCP rápida al puerto `9333` o `9334` antes de iniciar Playwright. Si Chrome ya está abierto manualmente en ese perfil, alertar al usuario inmediatamente con un mensaje claro en lugar de permitir que falle la automatización.
*   **Generaciones Concurrentes (Multi-Perfil):**
    *   *Detalle:* Parameterizar el puerto CDP y la carpeta de perfil para permitir correr 2 o 3 instancias del pipeline en paralelo en el mismo sistema utilizando perfiles distintos (`Profile 1`, `Profile 2`, etc.).

## 4. Auditoría de Audio Acelerada por GPU (RTX 4070 + CUDA)
*   **Aprovechamiento de la GPU RTX 4070 para Audio:**
    *   *Detalle:* Tu laptop con una GPU RTX 4070 es una bestia para procesamiento local de IA. Podemos configurar la auditoría de audio para que corra 100% en local sobre CUDA a máxima velocidad, utilizando el modelo más potente y preciso de Whisper (`large-v3`).
*   **Separación de Voz Avanzada con Demucs en GPU:**
    *   *Detalle:* Suno genera instrumentación densa que a veces confunde a Whisper. Ejecutando `demucs` con aceleración por GPU (`device="cuda"`), podemos separar el canal de voz limpia (vocals) de la música de fondo en cuestión de 5 segundos. Transcribir la pista de voz limpia aumenta enormemente la precisión de Whisper en nombres propios.
*   **Auditoría Local con `faster-whisper` (Large-v3 en float16):**
    *   *Detalle:* Configurar `faster-whisper` en Python/Node con:
        ```python
        model = WhisperModel("large-v3", device="cuda", compute_type="float16")
        ```
        Esto permite transcribir la letra cantada en segundos con la máxima precisión lingüística disponible hoy, capturando las pronunciaciones exactas de los nombres.
*   **Cálculo de Word Error Rate (WER) y Validación de Nombres:**
    *   *Detalle:* Un script comparará la transcripción limpia contra la letra oficial de `song.txt`. El pipeline marcará un fallo si:
        1. El porcentaje de error (WER) es superior al 25% (indica que Suno inventó letra o balbuceó).
        2. Los destinatarios de la encuesta (`firstNames`) no son detectados fonéticamente en el audio transcrito (Suno omitió o cambió el nombre del destinatario).
*   **Monitoreo del Balance de Créditos de Suno:**
    *   *Detalle:* Leer el elemento HTML de créditos disponibles en la interfaz de Suno al iniciar. Si los créditos son insuficientes para generar las 2 versiones, notificar inmediatamente por consola/NTFY en vez de esperar el timeout en el botón "Create".

## 5. Ideas post-refactor 2026-07-03 (checkpoints + dry-run del orquestador)
*   **Checkpoint remoto desde el celular:** hoy los checkpoints piden ENTER en la terminal. ntfy.sh soporta publicar de vuelta al tópico — se puede escuchar el tópico y aceptar un "OK" desde la app del celular como confirmación, sin ir a la PC.
*   **Screenshot adjunto en el ntfy del checkpoint:** ntfy soporta attachments (header `Attach`/PUT del archivo). Adjuntar `suno-verify-overview.png` al aviso del checkpoint pre-Create permitiría verificar la letra desde el celular.
*   ✅ **Checksum de song.txt en state.json (implementado 2026-07-03):** `startNew()` en `lib/pipeline-state.js` guarda `songTxtHash` (sha256 corto) al generar. `suno-fill.js` y `flow-submit.js` llaman `state.checkSongTxtContent()` al leer song.txt y avisan (advertencia, no abort — Gabo puede editar a mano) si el hash no coincide. Cubierto en `test/pipeline-state.test.js` vía la función pura `songTxtMatchesState` (nunca toca el state.json real en los tests).
*   **Detector de drift de selectores:** script standalone que abre suno.com/create y verifica que TODOS los selectores de `lib/suno-selectors.js` sigan existiendo — aviso temprano de rediseños de Suno antes de que reviente a mitad de una canción. (Sigue pendiente — requiere abrir una sesión real de Suno.)
*   ✅ **Tests para los parsers de song.txt (implementado 2026-07-03):** `parseSongFile` (antes duplicado en suno-fill.js y flow-submit.js, y una tercera variante suelta en lib/sheets-core.js) se unificó en `lib/song-file.js`, cubierto por `test/song-file.test.js`.
*   **Watchdog por paso:** timeout global configurable por etapa (ej. suno-create-dl > 15 min → ntfy urgent + pausa interactiva) para que un cuelgue silencioso nunca pase desapercibido.
*   ✅ **Higiene automática (implementado 2026-07-03):** `lib/hygiene.js` (`rotateOldRunFiles`) borra archivos de `logs/` y `screenshots/` de más de 30 días, llamado al final de un `--done` exitoso en `start-flow.js`. Cubierto en `test/hygiene.test.js` (carpeta temporal propia, nunca toca logs/screenshots reales).

## 6. Panel de Control de QA Local (Dashboard Express/React)
*   **Consola de Aprobación Visual:**
    *   *Detalle:* Levantar un servidor Express local muy ligero que exponga una interfaz web simple. En ella, el operador de QA puede ver el survey original, la letra de Claude, el checklist de errores, y escuchar los MP3s descargados lado a lado, reduciendo los tiempos del proceso manual de QA antes del "Submit".
