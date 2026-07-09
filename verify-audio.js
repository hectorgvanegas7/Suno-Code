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
const { extractFirstNames } = require('./lib/text-helpers');
const { applyPhoneticReplacements, readSunoLyricsCache, parseSongFile } = require('./lib/song-file');
const { analyzeAudio, prepareVocals, cleanupVocalsTmp, transcribeFiles, runClapScoreWithVocalIsolation, runNisqaScore, runF0GenderCheck, resolveVocalOrMixPaths, stripStructuralTags, printReport, pickBestVersion, parseLyricsFromSongFile, parseTituloFromSongFile, getDurationAsync, formatDuration, formatElapsed, SONG_PATH } = require('./lib/audio-analysis');
const { notify } = require('./lib/ntfy');

const SUNO_LYRICS_CACHE_PATH = path.join(__dirname, 'suno-lyrics-cache.json');

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
  let expectedGender = null;

  if (fs.existsSync(SONG_PATH)) {
    const content = fs.readFileSync(SONG_PATH, 'utf-8');
    if (!titulo) titulo = parseTituloFromSongFile(content);
    const voz = parseSongFile(content).voz;
    if (voz) expectedGender = /femenin/i.test(voz) ? 'Femenina' : /masculin/i.test(voz) ? 'Masculina' : null;
    // Preferir el cache que escribió suno-fill.js con la letra YA fonetizada
    // (exactamente lo que se tipeó en Suno) — fuente única, ver
    // lib/song-file.js. Si no hay cache (o es de otra canción/song.txt
    // cambió desde entonces), recalcular acá con el mismo helper: sin esto,
    // la comparación contra la transcripción usa la ortografía cruda de la
    // encuesta mientras el audio real canta la variante fonética (dict o
    // LLM), reintroduciendo falsos "nombre ausente" (ver LESSONS.md,
    // auditoría 2026-07-03 y regresión 2026-07-08).
    const cachedLyrics = readSunoLyricsCache(SUNO_LYRICS_CACHE_PATH, content);
    lyricsText = cachedLyrics !== null ? cachedLyrics : applyPhoneticReplacements(parseLyricsFromSongFile(content) || '');
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
    firstNames = extractFirstNames(surveyText);
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

  // Analizar cada versión. Con 2 versiones se usa el camino batcheado:
  // demucs por versión (secuencial — GPU) y UNA sola invocación de Whisper para
  // ambas, así el modelo (large-v3 con --demucs) se carga una única vez en vez
  // de pagar la carga dos veces.
  let reportA;
  let reportB = null;
  if (versionB) {
    console.log('⏳ Analizando Versiones A y B (Whisper se carga una sola vez para ambas)...');
    const useDemucs = !!args.demucs;
    const prepA = await prepareVocals(versionA.path, useDemucs);
    const prepB = await prepareVocals(versionB.path, useDemucs);
    let batch;
    let clapBatch;
    let nisqaBatch;
    let f0Batch;
    try {
      const cleanLyrics = stripStructuralTags(lyricsText);
      batch = transcribeFiles([prepA.targetPath, prepB.targetPath], {
        model: useDemucs ? 'large-v3' : 'small',
        device: useDemucs ? 'cuda' : null,
        initialPrompt: useDemucs && cleanLyrics ? cleanLyrics : null,
      });

      // CLAP: evaluar calidad perceptual de ambas versiones (modelo se carga 1
      // vez). vocal_clarity/emotion sobre la voz aislada de prepA/prepB si
      // demucs corrió, el resto sobre el mix. Tiene que correr ANTES del
      // finally — cleanupVocalsTmp borra el .wav de voz que prepX.targetPath
      // señala.
      console.log('🎧 Evaluando calidad de audio con CLAP...');
      clapBatch = runClapScoreWithVocalIsolation(
        [versionA.path, versionB.path],
        [prepA.demucs.used ? prepA.targetPath : null, prepB.demucs.used ? prepB.targetPath : null],
        { device: useDemucs ? 'cuda' : null },
      );

      // NISQA: MOS de naturalidad de voz sobre la voz aislada si demucs corrió,
      // si no sobre el mix — misma decisión que ya usa CLAP internamente
      // (resolveVocalOrMixPaths), reusada acá para no duplicar el criterio.
      // También tiene que correr ANTES del finally por el mismo motivo que CLAP.
      console.log('🗣️  Evaluando naturalidad de voz con NISQA...');
      const nisqaPaths = resolveVocalOrMixPaths(
        [versionA.path, versionB.path],
        [prepA.demucs.used ? prepA.targetPath : null, prepB.demucs.used ? prepB.targetPath : null],
      );
      nisqaBatch = runNisqaScore(nisqaPaths, { device: useDemucs ? 'cuda' : null });

      // F0 — género de voz (CPU, informativo). SOLO sobre la voz aislada por
      // demucs: sin aislar, pyin sobre la mezcla la dominan bajo/instrumentos
      // y el "género detectado" es ruido con apariencia de dato (auditoría
      // 2026-07-09). Igual que CLAP/NISQA, corre ANTES del finally
      // (cleanupVocalsTmp borra el .wav de voz).
      const isolatedPaths = [prepA.demucs.used ? prepA.targetPath : null, prepB.demucs.used ? prepB.targetPath : null];
      const toRunF0 = isolatedPaths.filter(Boolean);
      const f0NoVocalsError = 'sin voz aislada (demucs) — F0 sobre el mix completo no es confiable, no se corre';
      if (toRunF0.length > 0) {
        const ranF0 = runF0GenderCheck(toRunF0);
        let ranIdx = 0;
        f0Batch = {
          results: isolatedPaths.map((p) => p
            ? ranF0.results[ranIdx++]
            : { medianF0Hz: null, voicedRatio: null, detectedGender: null, error: f0NoVocalsError }),
          f0Ms: ranF0.f0Ms,
        };
      } else {
        f0Batch = {
          results: isolatedPaths.map(() => ({ medianF0Hz: null, voicedRatio: null, detectedGender: null, error: f0NoVocalsError })),
          f0Ms: null,
        };
      }
    } finally {
      cleanupVocalsTmp(prepA);
      cleanupVocalsTmp(prepB);
    }

    reportA = await analyzeAudio(versionA.path, {
      label: 'Versión A',
      titulo,
      lyricsText,
      useDemucs,
      duration: durationA,
      firstNames,
      prepared: prepA,
      transcriptionOutcome: batch.results[0],
      clapOutcome: clapBatch.results[0],
      nisqaOutcome: nisqaBatch.results[0],
      expectedGender,
      f0Outcome: f0Batch.results[0],
    });
    reportB = await analyzeAudio(versionB.path, {
      label: 'Versión B',
      titulo,
      lyricsText,
      useDemucs,
      duration: durationB,
      firstNames,
      prepared: prepB,
      transcriptionOutcome: batch.results[1],
      clapOutcome: clapBatch.results[1],
      nisqaOutcome: nisqaBatch.results[1],
      expectedGender,
      f0Outcome: f0Batch.results[1],
    });
  } else {
    console.log('⏳ Analizando Versión A... (puede tardar 1-3 minutos si Whisper necesita transcribir)');
    reportA = await analyzeAudio(versionA.path, {
      label: 'Versión A',
      titulo,
      lyricsText,
      useDemucs: !!args.demucs,
      duration: durationA,
      firstNames,
      expectedGender,
    });
  }

  // Imprimir reporte completo
  printReport(titulo, reportA, reportB);

  // Generar recomendación y guardar reporte a JSON
  const recommendation = pickBestVersion(reportA, reportB);
  const REPORT_PATH = path.join(__dirname, 'verify-report.json');
  try {
    fs.writeFileSync(REPORT_PATH, JSON.stringify({
      titulo,
      recommendation,
      reportA: {
        label: 'Versión A',
        path: versionA.path,
        durationFormatted: reportA.durationFormatted,
        durationOk: reportA.durationOk,
        levenshteinScore: reportA.levenshteinScore,
        clippingFlag: reportA.clippingFlag,
        abruptCutoff: reportA.abruptCutoff,
        titleCantado: reportA.titleCantado,
        tagLeaking: reportA.tagLeaking,
        missingNames: reportA.missingNames,
        nameAudioChecks: reportA.nameAudioChecks,
        namePacingIssues: reportA.namePacingIssues,
        pacingIssuesCount: reportA.pacingIssues.length,
        clap: reportA.clap,
        nisqa: reportA.nisqa,
        // Señales informativas nuevas — también van al JSON: antes solo
        // existían en la consola y el reporte persistido las omitía, así que
        // eran invisibles para start-flow y para revisión posterior
        // (auditoría 2026-07-09).
        loudness: reportA.loudness ?? null,
        f0Gender: reportA.f0Gender ?? null,
        truncatedWords: reportA.truncatedWords ?? [],
        summary: reportA.summary,
      },
      reportB: reportB ? {
        label: 'Versión B',
        path: reportB ? versionB.path : null,
        durationFormatted: reportB.durationFormatted,
        durationOk: reportB.durationOk,
        levenshteinScore: reportB.levenshteinScore,
        clippingFlag: reportB.clippingFlag,
        abruptCutoff: reportB.abruptCutoff,
        titleCantado: reportB.titleCantado,
        tagLeaking: reportB.tagLeaking,
        missingNames: reportB.missingNames,
        nameAudioChecks: reportB.nameAudioChecks,
        namePacingIssues: reportB.namePacingIssues,
        pacingIssuesCount: reportB.pacingIssues.length,
        clap: reportB.clap,
        nisqa: reportB.nisqa,
        loudness: reportB.loudness ?? null,
        f0Gender: reportB.f0Gender ?? null,
        truncatedWords: reportB.truncatedWords ?? [],
        summary: reportB.summary,
      } : null,
      timestamp: new Date().toISOString(),
    }, null, 2), 'utf-8');
    console.log(`📄 Reporte guardado en ${REPORT_PATH}`);
  } catch (e) {
    console.warn(`⚠️ No se pudo guardar verify-report.json: ${e.message}`);
  }

  // Log de calibración para el umbral de "palabras pegadas sin pausa"
  // (NAME_GAP_MERGE_THRESHOLD_S / GENERAL_GAP_MERGE_THRESHOLD_S en
  // lib/audio-analysis.js). SOLO logging — no es entrenamiento de un modelo,
  // es un registro para que Hector pueda ajustar el umbral a mano más
  // adelante con casos reales confirmados, mismo criterio que ya se usó para
  // calibrar CLAP/NISQA.
  try {
    const PACING_LOG_PATH = path.join(__dirname, 'logs', 'pacing-feedback.jsonl');
    const logLine = JSON.stringify({
      timestamp: new Date().toISOString(),
      titulo,
      versionA: { namePacingIssues: reportA.namePacingIssues, pacingIssuesCount: reportA.pacingIssues.length },
      versionB: reportB ? { namePacingIssues: reportB.namePacingIssues, pacingIssuesCount: reportB.pacingIssues.length } : null,
    });
    fs.appendFileSync(PACING_LOG_PATH, logLine + '\n', 'utf-8');
  } catch (e) {
    console.warn(`⚠️ No se pudo escribir logs/pacing-feedback.jsonl: ${e.message}`);
  }

  console.log(`\n📊 RECOMENDACIÓN: Versión ${recommendation.recommended}`);
  console.log(`   Razón: ${recommendation.reason}`);
  if (recommendation.scoreB !== null) {
    console.log(`   Puntajes: A=${recommendation.scoreA}, B=${recommendation.scoreB}`);
  }

  const overallElapsedMs = Date.now() - overallStart;
  console.log(`\n⏱️  verify-audio.js completo en ${formatElapsed(overallElapsedMs)}.\n`);

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
    if (report.missingNames && report.missingNames.length > 0) parts.push(`nombres ausentes: ${report.missingNames.join(',')}`);
    const unconfirmed = (report.nameAudioChecks || []).filter((c) => c.confirmed === false);
    if (unconfirmed.length > 0) parts.push(`pronunciación a revisar: ${unconfirmed.map((c) => c.name).join(',')}`);
    if (report.namePacingIssues && report.namePacingIssues.length > 0) parts.push(`nombre pegado: ${report.namePacingIssues.map((c) => c.name).join(',')}`);
    if (report.demucs.used && report.demucs.vocalPresence === true) parts.push('sin voz');
    if (report.clap && report.clap.score !== null) parts.push(`CLAP:${report.clap.score}`);
    if (report.nisqa && report.nisqa.score !== null) parts.push(`NISQA:${report.nisqa.score}`);
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
