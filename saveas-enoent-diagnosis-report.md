# Reporte de Diagnóstico y Fix: Error ENOENT en `download.saveAs()` con CDP

## 1. Causa Raíz Confirmada

La hipótesis fue **100% confirmada** mediante pruebas en vivo sobre la sesión activa de Chrome en el puerto 9333.

### El conflicto técnico
Cuando Playwright se conecta a una instancia de Chrome existente a través de `connectOverCDP`:
1. Playwright **no controla la inicialización del navegador**. Chrome ya tiene sus propios manejadores de descargas por defecto.
2. Si llamamos a `Browser.setDownloadBehavior` con `behavior: 'allow'` y `downloadPath: sunoDir`, Chrome intercepta la descarga a nivel de navegador y escribe el archivo directamente en `sunoDir` usando el nombre sugerido por el servidor (ej: `Cuarenta Años y un Pedazo de Pizza.mp3`).
3. Al ocurrir esto, el archivo **nunca se escribe en el directorio temporal interno de Playwright** (`C:\Users\hecto\AppData\Local\Temp\playwright-artifacts-XXXXXX`).
4. Cuando el script ejecuta `await download.saveAs(destPath)`, Playwright busca el archivo en su directorio de artifacts temporal (que está vacío) y lanza el error:
   `ENOENT: no such file or directory, copyfile 'C:\Users\hecto\AppData\Local\Temp\playwright-artifacts-XXXXXX\... -> ...`

---

## 2. Mitigación de Riesgos y Mejoras de Seguridad Implementadas

### A. Recuperación del Timeout de Descarga (8 minutos)
Para evitar que el script se cuelgue indefinidamente en descargas lentas o estancadas, se volvió a envolver la espera `download.failure()` en un `Promise.race` contra `DOWNLOAD_WAIT_TIMEOUT_MS`. Si la descarga no se completa en 8 minutos, fallará de forma limpia permitiendo las notificaciones y fallbacks normales del pipeline.

### B. Protección de Archivos Legítimos en sunoDir (No borrar a ciegas)
Para evitar pisotear o borrar archivos legítimos de otras canciones completadas anteriormente que coincidan en el título saneado:
1. **Sin Borrado Previo:** Se eliminó por completo la eliminación previa de archivos de `sunoDir`.
2. **Localización Basada en Recencia (`mtime`):** Implementamos la función `findDownloadedFile()`. Al iniciar cada descarga, guardamos la estampa de tiempo de inicio (`downloadStartTime = Date.now() - 5000`).
3. Al terminar la descarga, el bot escanea la carpeta buscando archivos que coincidan con la expresión regular del título (soportando sufijos de colisión nativos de Chrome como ` (1)`, ` (2)`, etc.) y selecciona el que tenga la fecha de modificación más reciente posterior a `downloadStartTime`.
4. Esto garantiza que:
   - Los archivos viejos de otras ejecuciones son ignorados por completo y quedan intactos.
   - El bot siempre localiza el archivo correcto de la descarga actual, incluso si Chrome lo guardó como `Título (1).mp3` por colisión física.
   - Inmediatamente después de localizarlo, lo renombra a su destino temporal/definitivo de la corrida actual, dejando la carpeta limpia.

---

## 3. Cambios Implementados en `lib/suno-create-dl.js`

### Helper `findDownloadedFile`
```javascript
// Localiza el archivo que Chrome realmente descargó en sunoDir buscando
// el más reciente modificado después de startTime que coincida con el título.
// Esto permite que conviva con preexistentes y que Chrome use el sufijo nativo " (1)".
function findDownloadedFile(sunoDir, cleanTitle, startTime) {
  const files = fs.readdirSync(sunoDir);
  const escapedTitle = cleanTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escapedTitle}(\\s\\(\\d+\\))?\\.mp3$`, 'i');

  let bestFile = null;
  let bestMtime = 0;

  for (const f of files) {
    if (regex.test(f)) {
      const fullPath = path.join(sunoDir, f);
      const stat = fs.statSync(fullPath);
      // Solo tomamos en cuenta archivos modificados después del inicio de la descarga
      if (stat.mtimeMs >= startTime && stat.mtimeMs > bestMtime) {
        bestMtime = stat.mtimeMs;
        bestFile = fullPath;
      }
    }
  }
  return bestFile;
}
```

### Bucle de descargas en `createAndDownload`
```javascript
    const cleanTitle = verify.titulo.replace(/[<>:"\/\\|?*]+/g, '').trim();
    const versionLabels = ['A', 'B'];

    const plans = []; // { label, destPath, download, tempDestPath }
    for (let i = 0; i < readyCards.length; i++) {
      const versionLabel = versionLabels[i];
      // Para evitar que Chrome renombre la versión B a "Cancion (1).mp3" por colisión
      // de nombre sugerido en sunoDir, descargaremos la versión A e inmediatamente
      // la renombraremos a un nombre temporal (cancion_temp_a.mp3) antes de iniciar
      // la descarga de B. Al final del proceso, renombramos el temporal a su nombre definitivo.
      const fileName = (i === 0) ? `${cleanTitle}.mp3` : `${cleanTitle} ${versionLabel}.mp3`;
      const destPath = getUniqueDestPath(path.join(sunoDir, fileName));
      const tempDestPath = (i === 0) ? path.join(sunoDir, `${cleanTitle}_temp_a.mp3`) : destPath;

      // Hora de inicio de la descarga para identificar el archivo correcto en sunoDir.
      // Restamos 5 segundos como margen de tolerancia para skews de reloj del sistema de archivos.
      const downloadStartTime = Date.now() - 5000;

      console.log(`\n  Iniciando descarga Versión ${versionLabel} (⋯ → Download → MP3 Audio) — "${readyCards[i].title}"...`);
      let download = null;
      try {
        download = await clickDownloadMp3(page, readyCards[i].href, versionLabel, DOWNLOAD_WAIT_TIMEOUT_MS);
      } catch (e) {
        console.log(`  ❌ No se pudo iniciar la descarga de la Versión ${versionLabel}: ${e.message}`);
      }
      if (!download) {
        try {
          download = await awaitManualDownload(page, versionLabel, DOWNLOAD_WAIT_TIMEOUT_MS);
        } catch (e) {
          console.log(`  ❌ ${e.message}`);
        }
      }

      if (download) {
        try {
          console.log(`  ⏳ Esperando que Chrome complete la descarga de la Versión ${versionLabel}...`);
          const failure = await Promise.race([
            download.failure(),
            new Promise((_, reject) => setTimeout(
              () => reject(new Error(`Timeout ${DOWNLOAD_WAIT_TIMEOUT_MS}ms esperando la descarga en Chrome.`)),
              DOWNLOAD_WAIT_TIMEOUT_MS
            )),
          ]);
          if (failure) {
            throw new Error(`Chrome reportó fallo en la descarga: ${failure}`);
          }

          // Pequeño delay para liberar lock de escritura del sistema
          await new Promise(r => setTimeout(r, 200));

          // Encontrar el archivo que Chrome realmente escribió en el directorio de descargas de Suno,
          // soportando sufijos automáticos de colisión nativos de Chrome (" (1)", " (2)", etc.)
          // en lugar de borrar archivos preexistentes ciegamente.
          const currentDownloadedFile = findDownloadedFile(sunoDir, cleanTitle, downloadStartTime);
          if (!currentDownloadedFile) {
            throw new Error(`El archivo descargado no se pudo localizar en ${sunoDir} bajo el patrón de "${cleanTitle}".`);
          }

          // Renombrar inmediatamente al path temporal o definitivo
          fs.renameSync(currentDownloadedFile, tempDestPath);
          console.log(`  ✅ Versión ${versionLabel} descargada y guardada temporalmente en: ${path.basename(tempDestPath)}`);
          plans.push({ label: versionLabel, destPath, tempDestPath, success: true });
        } catch (err) {
          console.log(`  ❌ Error procesando el archivo de la Versión ${versionLabel}: ${err.message}`);
          plans.push({ label: versionLabel, destPath, tempDestPath, success: false });
        }
      } else {
        plans.push({ label: versionLabel, destPath, tempDestPath, success: false });
      }

      await page.waitForTimeout(500);
    }
```
