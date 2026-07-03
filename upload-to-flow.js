// upload-to-flow.js — Sube el MP3 elegido al campo de archivo del Flow.
//
// Uso:
//   node upload-to-flow.js --version A         → sube Versión A (buscada por título)
//   node upload-to-flow.js --version B         → sube Versión B
//   node upload-to-flow.js --file "ruta.mp3"   → sube un archivo específico
//
// ══════════════════════════════════════════════════════════════════════════════
// 🛑 REGLA DURA #1 — NUNCA HACER SUBMIT TO QA
// ══════════════════════════════════════════════════════════════════════════════
// Este script SOLAMENTE sube el MP3 al campo de archivo del Flow y SE DETIENE.
// JAMÁS, bajo ningún motivo, hace click en "Submit to QA" o "Complete Song".
// El Submit es 100% manual — siempre. Un submit automático costaría un redo
// sin pago si el artista cambia de opinión después de escuchar.
//
// Si en algún refactor futuro alguien quiere "agregar el submit automático":
//   → NO. La restricción es de diseño, no un flag configurable.
//   → Ver REGLA DURA #1 en CLAUDE.md.
// ══════════════════════════════════════════════════════════════════════════════

const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findSunoMp3s } = require('./lib/audio-match');
const { pauseForHumanInteraction, isPortUp } = require('./lib/playwright-helpers');
const state = require('./lib/pipeline-state');
const { parseTituloFromSongFile: parseTitulo } = require('./lib/audio-analysis');

const DEBUG_PORT = 9333;
const SONG_PATH = path.join(__dirname, 'song.txt');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--version' && argv[i + 1]) { args.version = argv[++i].toUpperCase(); }
    else if (argv[i] === '--file' && argv[i + 1]) { args.file = argv[++i]; }
    else if (argv[i] === '--minutes' && argv[i + 1]) { args.minutes = parseInt(argv[++i], 10); }
  }
  return args;
}

(async () => {
  const cliArgs = parseArgs(process.argv.slice(2));

  // Determinar qué archivo subir
  let mp3Path = null;

  if (cliArgs.file) {
    mp3Path = path.resolve(cliArgs.file);
    if (!fs.existsSync(mp3Path)) {
      console.error(`❌ Archivo no encontrado: ${mp3Path}`);
      process.exit(1);
    }
    console.log(`\n📁 Archivo especificado: ${mp3Path}`);
  } else if (cliArgs.version) {
    if (!['A', 'B'].includes(cliArgs.version)) {
      console.error('❌ --version debe ser A o B');
      process.exit(1);
    }
    if (!fs.existsSync(SONG_PATH)) {
      console.error('❌ song.txt no encontrado. Pasá el archivo directamente con --file.');
      process.exit(1);
    }
    const titulo = parseTitulo(fs.readFileSync(SONG_PATH, 'utf-8'));
    if (!titulo) {
      console.error('❌ No se pudo leer el título de song.txt. Usá --file directamente.');
      process.exit(1);
    }
    console.log(`\n🔍 Buscando Versión ${cliArgs.version} para: "${titulo}"`);
    try {
      const { versionA, versionB } = findSunoMp3s(titulo, { recencyMinutes: cliArgs.minutes || 60 });
      const chosen = cliArgs.version === 'A' ? versionA : versionB;
      if (!chosen) {
        console.error(`❌ No se encontró Versión ${cliArgs.version}. Usá --file directamente.`);
        process.exit(1);
      }
      mp3Path = chosen.path;
      console.log(`   Archivo: ${mp3Path}`);
    } catch (e) {
      console.error(`❌ ${e.message}`);
      process.exit(1);
    }
  } else {
    console.error('❌ Usá --version A|B o --file "ruta.mp3"');
    console.error('   Ejemplos:');
    console.error('     node upload-to-flow.js --version A');
    console.error('     node upload-to-flow.js --file "C:\\Users\\hecto\\Downloads\\suno\\20260630-mi-cancion-A.mp3"');
    process.exit(1);
  }

  // Verificar que el archivo existe y no está a medias
  if (!fs.existsSync(mp3Path)) {
    console.error(`❌ Archivo no encontrado: ${mp3Path}`);
    process.exit(1);
  }
  const stat = fs.statSync(mp3Path);
  if (stat.size < 10000) {
    console.error(`❌ Archivo demasiado pequeño (${stat.size} bytes) — posiblemente descarga incompleta.`);
    process.exit(1);
  }
  console.log(`   Tamaño: ${Math.round(stat.size / 1024)} KB`);

  // Conectar al Flow
  console.log('\n📡 Conectando al Flow...');
  if (!(await isPortUp(DEBUG_PORT))) {
    throw new Error(`❌ Chrome no está escuchando en el puerto ${DEBUG_PORT}. ¿Olvidaste iniciarlo con la flag de debugging?`);
  }

  // Conectar a Chrome existente
  const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    console.error("❌ No hay contextos de navegador disponibles.");
    process.exit(1);
  }
  const context = contexts[0];
  const pages = context.pages();
  const page = pages.find((p) => p.url().includes('cancioneterna.com'));
  if (!page) {
    const urls = pages.map((p) => p.url()).join(', ') || '(ninguna)';
    console.error(`❌ No se encontró tab de cancioneterna.com. Tabs: ${urls}`);
    process.exit(1);
  }
  await page.bringToFront();
  console.log(`   Conectado: ${page.url()}`);

  // Buscar campo de archivo para MP3
  console.log('\n🔍 Buscando campo de carga de MP3...');
  const fileInputSelectors = [
    'input[type="file"][accept*="audio"]',
    'input[type="file"][accept*="mp3"]',
    'input[type="file"][accept*="mpeg"]',
    'input[type="file"]',
  ];

  let fileInput = null;
  for (const sel of fileInputSelectors) {
    const inputs = page.locator(sel);
    const count = await inputs.count();
    if (count > 0) {
      fileInput = inputs.first();
      console.log(`   Campo encontrado: ${sel}`);
      break;
    }
  }

  if (!fileInput) {
    // Intentar encontrar por labels relacionados con audio/mp3
    const byLabel = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      return inputs.map((inp, i) => {
        const label = document.querySelector(`label[for="${inp.id}"]`)?.innerText || '';
        return { idx: i, id: inp.id, label, accept: inp.accept };
      });
    });
    console.log('   Inputs de tipo file encontrados:', JSON.stringify(byLabel));

    if (byLabel.length > 0) {
      fileInput = page.locator('input[type="file"]').first();
      console.log('   Usando primer input[type="file"] disponible.');
    } else {
      console.error('\n❌ No se encontró ningún campo de carga de archivo en el Flow.');
      await pauseForHumanInteraction('No se encontró el botón para subir el MP3 en la interfaz del Flow. Por favor, súbelo manualmente y presiona ENTER.');
    }
  }

  // Preparar el archivo a subir: QA quiere el nombre limpio (solo el título,
  // sin fecha ni sufijo A/B interno) en la UI del Flow. Antes de confiar en el
  // título de state.json para renombrar, lo cruzamos contra song.txt — si no
  // coinciden (state.json desactualizado por un REDO o una corrida cortada a
  // mitad de camino), NUNCA renombramos: se sube el archivo original tal cual,
  // para no arriesgar un nombre incorrecto en el Flow (ver lib/pipeline-state.js).
  let uploadPath = mp3Path;
  try {
    const current = state.read();
    const songContent = fs.existsSync(SONG_PATH) ? fs.readFileSync(SONG_PATH, 'utf-8') : '';
    const songTxtTitle = parseTitulo(songContent);

    if (current && current.songId && current.titulo) {
      if (songTxtTitle && songTxtTitle !== current.titulo) {
        console.warn(`  ⚠️ Peligro: El título en state.json ("${current.titulo}") no coincide con song.txt ("${songTxtTitle}"). Se sube el archivo original sin renombrar.`);
      } else if (!current.titulo.replace(/[<>:"\/\\|?*]+/g, '').trim()) {
        console.warn('  ⚠️ El título quedó vacío al sanitizarlo — se sube el archivo original sin renombrar.');
      } else {
        const destDir = path.join(__dirname, 'mp3');
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir);
        const cleanTitle = current.titulo.replace(/[<>:"\/\\|?*]+/g, '').trim();

        // Backup en mp3/ con Song ID — único por convención (CLAUDE.md), para
        // que dos canciones con el mismo título nunca se pisen el archivo.
        const backupName = `${current.songId} - ${cleanTitle}.mp3`;
        fs.copyFileSync(mp3Path, path.join(destDir, backupName));
        console.log(`  📁 Copia de respaldo guardada en: mp3/${backupName}`);

        // Copia aparte con nombre 100% limpio (sin Song ID) SOLO para subir al
        // Flow — en un temp, no en mp3/, para no repetir el riesgo de colisión
        // por título duplicado en la carpeta de respaldo.
        const uploadDestPath = path.join(os.tmpdir(), `${cleanTitle}.mp3`);
        fs.copyFileSync(mp3Path, uploadDestPath);
        uploadPath = uploadDestPath;
      }
    } else {
      console.warn('  ⚠️ state.json incompleto o ausente. Se sube el archivo original sin renombrar.');
    }
  } catch (e) {
    console.warn(`  ⚠️ No se pudo preparar el archivo con nombre limpio: ${e.message}`);
  }

  // Subir el archivo
  console.log(`\n⬆️  Subiendo: ${path.basename(uploadPath)}`);
  try {
    if (fileInput) {
      await fileInput.setInputFiles(uploadPath);
      await page.waitForTimeout(2000);
    }
  } catch (e) {
    console.error(`❌ Error al subir el archivo programáticamente: ${e.message}`);
    await pauseForHumanInteraction('Ocurrió un error intentando subir el MP3. Por favor, súbelo manualmente al Flow y presiona ENTER al finalizar.');
  }

  // Verificar que la UI muestre el archivo cargado — chequear el nombre que
  // REALMENTE se subió (uploadPath), no el original: si se renombró, el Flow
  // muestra el nombre limpio y buscar el original acá siempre daría falso negativo.
  const uploadConfirmed = await page.evaluate((filename) => {
    // Buscar el nombre del archivo en el DOM (suele aparecer cerca del input)
    const text = document.body.innerText || '';
    return text.includes(filename) || document.querySelector('audio[src]') !== null;
  }, path.basename(uploadPath)).catch(() => false);

  await page.screenshot({ path: 'flow-upload-verify.png', fullPage: true });

  if (uploadConfirmed) {
    console.log('  ✅ Archivo visible en la UI del Flow.');
  } else {
    console.log('  ⚠️  No se pudo confirmar que el archivo quedó en la UI (revisá flow-upload-verify.png).');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 🛑 DETENER ACÁ — NO CONTINUAR CON SUBMIT TO QA
  // Este es el límite del script. El Submit siempre es manual.
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('✅ MP3 subido al Flow. Escuchá/revisá y hacé Submit to QA vos cuando estés conforme.');
  console.log('   → El script SE DETIENE ACÁ. El Submit to QA es siempre manual.');
  console.log('   → Screenshot de verificación: flow-upload-verify.png');
  console.log('   → Cuando termines el Submit, registrá: node start-flow.js --done');
  console.log('══════════════════════════════════════════════════════════════════\n');

  // Desconectar la sesión CDP para que Node pueda terminar. Sobre connectOverCDP,
  // browser.close() SOLO desconecta — Chrome y la pestaña del Flow quedan
  // abiertos para el Submit manual (verificado en Playwright 1.61; sin esto el
  // proceso cuelga y start-flow.js se queda esperando el exit para siempre).
  await browser.close().catch(() => {});
})().catch((err) => {
  console.error('upload-to-flow.js falló:', err.message);
  process.exit(1);
});
