// verify-audio.js — Análisis de las 2 versiones de Suno generadas.
//
// Uso:
//   node verify-audio.js                    → título desde song.txt
//   node verify-audio.js --title "El amor"  → título manual
//   node verify-audio.js --dir "C:\ruta"    → directorio alternativo
//   node verify-audio.js --minutes 30       → ventana de recencia (default 20)
//   node verify-audio.js --demucs           → pipeline avanzado (ver abajo)
//
// Qué hace:
//   1. Encuentra los 2 MP3 que coinciden con el título en Downloads/suno/
//   2. Verifica duración con ffprobe (2:45–3:30 = OK, en paralelo para A y B)
//      + corte abrupto + clipping
//   3. Transcribe con Whisper y compara contra song.txt (Levenshtein) +
//      chequeo de tags de estructura cantados
//   4. Imprime reporte orientativo (NUNCA elige versión)
//   5. Notifica por ntfy cuando termina
//
// Con --demucs: separa voz con demucs (htdemucs_ft) antes de transcribir,
//   usa Whisper large-v3 en CUDA (RTX 4070, con fallback automático a CPU si
//   CUDA no está disponible) y agrega el chequeo de "instrumental accidental".
//   Requiere: pip install demucs (ver lib/audio-analysis.js). Si demucs no
//   está instalado, avisa y sigue transcribiendo el MP3 completo.
// Sin --demucs: comportamiento idéntico al de siempre (Whisper small en CPU).
//
// NUNCA sube nada, NUNCA elige versión, NUNCA toca el Flow.

const fs = require('fs');
const path = require('path');
const { findSunoMp3s, SUNO_DIR } = require('./lib/audio-match');
const { analyzeAudio, printReport, parseLyricsFromSongFile, parseTituloFromSongFile, getDurationAsync, formatDuration, formatElapsed, SONG_PATH } = require('./lib/audio-analysis');
const { notify } = require('./lib/ntfy');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--title' && argv[i + 1]) { args.title = argv[++i]; }
    else if (argv[i] === '--dir' && argv[i + 1]) { args.dir = argv[++i]; }
    else if (argv[i] === '--minutes' && argv[i + 1]) { args.minutes = parseInt(argv[++i], 10); }
    else if (argv[i] === '--demucs') { args.demucs = true; }
  }
  return args;
}

(async () => {
  const overallStart = Date.now();
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

  // Extraer nombres desde survey.txt si existe para validar presencia en audio
  let firstNames = [];
  const SURVEY_PATH = path.join(__dirname, 'survey.txt');
  if (fs.existsSync(SURVEY_PATH)) {
    const surveyText = fs.readFileSync(SURVEY_PATH, 'utf-8');
    const nameFieldRaw =
      (surveyText.match(/What['']s their name\??:\s*([^\n]+)/i) ||
        surveyText.match(/Nombre[^:]*:\s*([^\n]+)/i) || [])[1] || '';
    const NAME_FIELD_FILLER_WORDS = new Set([
      'mis', 'mi', 'su', 'sus', 'el', 'la', 'los', 'las', 'de', 'del',
      'hijo', 'hija', 'hijos', 'hijas', 'y', 'and', 'e',
    ]);
    firstNames = [
      ...new Set(
        nameFieldRaw
          .replace(/[.,]/g, ' ')
          .split(/\s+/)
          .map((w) => w.toLowerCase())
          .filter((w) => w.length > 1 && !NAME_FIELD_FILLER_WORDS.has(w))
      ),
    ];
  }

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

  if (args.demucs) {
    console.log('🎚️  --demucs activo: separación de voz (htdemucs_ft) + Whisper large-v3 CUDA.\n');
  }

  // Duración de A y B en paralelo (no hace falta esperar a una para la otra)
  const [durationA, durationB] = await Promise.all([
    getDurationAsync(versionA.path),
    versionB ? getDurationAsync(versionB.path) : Promise.resolve(null),
  ]);
  console.log(`⏱️  Duración — A: ${formatDuration(durationA)}${versionB ? `, B: ${formatDuration(durationB)}` : ''}\n`);

  // Analizar cada versión
  console.log('⏳ Analizando Versión A... (puede tardar 1-3 minutos si Whisper necesita transcribir)');
  const reportA = await analyzeAudio(versionA.path, {
    label: 'Versión A',
    titulo,
    lyricsText,
    useDemucs: !!args.demucs,
    duration: durationA,
    firstNames,
  });

  let reportB = null;
  if (versionB) {
    console.log('⏳ Analizando Versión B...');
    reportB = await analyzeAudio(versionB.path, {
      label: 'Versión B',
      titulo,
      lyricsText,
      useDemucs: !!args.demucs,
      duration: durationB,
      firstNames,
    });
  }

  // Imprimir reporte completo
  printReport(titulo, reportA, reportB);

  const overallElapsedMs = Date.now() - overallStart;
  console.log(`⏱️  verify-audio.js completo en ${formatElapsed(overallElapsedMs)}.\n`);

  // Próximos pasos
  console.log('Próximos pasos:');
  console.log('  1. Escuchá las 2 versiones (A y B)');
  console.log('  2. Elegí la que te convenza');
  console.log('  3. Corrí: node upload-to-flow.js --version A   (o B)');
  console.log('     O:     node upload-to-flow.js --file "ruta/al/archivo.mp3"');
  console.log('');

  // Notificación
  function extraFlags(report) {
    const parts = [];
    if (report.levenshteinScore !== null) parts.push(`letra ${Math.round(report.levenshteinScore * 100)}%`);
    if (report.clippingFlag) parts.push(`clipping ${report.clippingCount}`);
    if (report.abruptCutoff === true) parts.push('final abrupto');
    if (report.tagLeaking.length > 0) parts.push('tags cantados');
    if (report.demucs.used && report.demucs.vocalPresence === true) parts.push('sin voz');
    return parts.length ? ` (${parts.join(', ')})` : '';
  }

  const notifyMsg = versionB
    ? `Análisis listo (${formatElapsed(overallElapsedMs)}): "${titulo}"\nA=${reportA.durationFormatted}${extraFlags(reportA)}, B=${reportB.durationFormatted}${extraFlags(reportB)}.\nElegí versión y corrí upload-to-flow.js`
    : `Análisis listo (${formatElapsed(overallElapsedMs)}, 1 versión): "${titulo}" - ${reportA.durationFormatted}${extraFlags(reportA)}`;
  await notify(notifyMsg, { title: 'Análisis de audio listo', priority: 'high', tags: 'headphones' });
})().catch((err) => {
  console.error('verify-audio.js falló:', err.message);
  process.exit(1);
});
