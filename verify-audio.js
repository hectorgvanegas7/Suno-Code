// verify-audio.js — Análisis de las 2 versiones de Suno generadas.
//
// Uso:
//   node verify-audio.js                    → título desde song.txt
//   node verify-audio.js --title "El amor"  → título manual
//   node verify-audio.js --dir "C:\ruta"    → directorio alternativo
//   node verify-audio.js --minutes 30       → ventana de recencia (default 20)
//
// Qué hace:
//   1. Encuentra los 2 MP3 que coinciden con el título en Downloads/suno/
//   2. Verifica duración con ffprobe (2:45–3:30 = OK)
//   3. Transcribe con Whisper y compara contra song.txt
//   4. Imprime reporte orientativo (NUNCA elige versión)
//   5. Notifica por ntfy cuando termina
//
// NUNCA sube nada, NUNCA elige versión, NUNCA toca el Flow.

const fs = require('fs');
const path = require('path');
const { findSunoMp3s, SUNO_DIR } = require('./lib/audio-match');
const { analyzeAudio, printReport, parseLyricsFromSongFile, parseTituloFromSongFile, SONG_PATH } = require('./lib/audio-analysis');
const { notify } = require('./lib/ntfy');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--title' && argv[i + 1]) { args.title = argv[++i]; }
    else if (argv[i] === '--dir' && argv[i + 1]) { args.dir = argv[++i]; }
    else if (argv[i] === '--minutes' && argv[i + 1]) { args.minutes = parseInt(argv[++i], 10); }
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));

  // Leer título y letra de song.txt (o arg manual)
  let titulo = args.title || null;
  let lyricsText = '';

  if (fs.existsSync(SONG_PATH)) {
    const content = fs.readFileSync(SONG_PATH, 'utf-8');
    if (!titulo) titulo = parseTituloFromSongFile(content);
    lyricsText = parseLyricsFromSongFile(content) || '';
  }

  if (!titulo) {
    console.error('❌ No se pudo obtener el título. Pasalo con --title "El título"');
    process.exit(1);
  }

  console.log(`\n🔍 Buscando MP3 para: "${titulo}"`);
  console.log(`   Carpeta: ${args.dir || SUNO_DIR}`);
  console.log(`   Ventana de recencia: ${args.minutes || 20} minutos\n`);

  // Encontrar los 2 MP3
  let versionA, versionB;
  try {
    const result = findSunoMp3s(titulo, {
      recencyMinutes: args.minutes || 20,
      sunoDir: args.dir || SUNO_DIR,
    });
    versionA = result.versionA;
    versionB = result.versionB;
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  console.log(`📁 Versión A: ${versionA.name} (${new Date(versionA.mtime).toLocaleTimeString()})`);
  if (versionB) {
    console.log(`📁 Versión B: ${versionB.name} (${new Date(versionB.mtime).toLocaleTimeString()})`);
  }
  console.log('');

  if (!lyricsText) {
    console.log('⚠️  No se encontró song.txt — solo se analizará duración.\n');
  }

  // Analizar cada versión
  console.log('⏳ Analizando Versión A... (puede tardar 1-3 minutos si Whisper necesita transcribir)');
  const reportA = await analyzeAudio(versionA.path, {
    label: 'Versión A',
    titulo,
    lyricsText,
  });

  let reportB = null;
  if (versionB) {
    console.log('⏳ Analizando Versión B...');
    reportB = await analyzeAudio(versionB.path, {
      label: 'Versión B',
      titulo,
      lyricsText,
    });
  }

  // Imprimir reporte completo
  printReport(titulo, reportA, reportB);

  // Próximos pasos
  console.log('Próximos pasos:');
  console.log('  1. Escuchá las 2 versiones (A y B)');
  console.log('  2. Elegí la que te convenza');
  console.log('  3. Corrí: node upload-to-flow.js --version A   (o B)');
  console.log('     O:     node upload-to-flow.js --file "ruta/al/archivo.mp3"');
  console.log('');

  // Notificación
  const notifyMsg = versionB
    ? `Análisis listo: "${titulo}"\nA=${reportA.durationFormatted}, B=${reportB.durationFormatted}.\nElegí versión y corrí upload-to-flow.js`
    : `Análisis listo (1 versión): "${titulo}" - ${reportA.durationFormatted}`;
  await notify(notifyMsg, { title: 'Análisis de audio listo', priority: 'high', tags: 'headphones' });
})().catch((err) => {
  console.error('verify-audio.js falló:', err.message);
  process.exit(1);
});
