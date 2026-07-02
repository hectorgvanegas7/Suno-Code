// lib/audio-analysis.js — Análisis de MP3: duración (ffprobe) + calidad de audio
// (corte abrupto, clipping) + transcripción (Whisper via Python) + comparación
// contra song.txt (Levenshtein) + separación de voz opcional (demucs).
//
// INFORMA, no decide. Nunca sube nada, nunca elige versión.
// Whisper sobre canto da falsos positivos — siempre aclararlo en la salida.
//
// Instalación de dependencias avanzadas (opcionales, degradan con gracia si faltan):
//   npm install fastest-levenshtein
//   pip install faster-whisper
//   pip install torch --index-url https://download.pytorch.org/whl/cu124
//   pip install torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124
//   pip install soundfile
//   pip install demucs   (opcional — solo hace falta para --demucs)

const { spawnSync, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { distance } = require('fastest-levenshtein');

const SONG_PATH = path.join(__dirname, '..', 'song.txt');
const TRANSCRIBE_SCRIPT = path.join(__dirname, 'transcribe.py');

// Duración ideal de una canción (segundos)
const MIN_DURATION_S = 2 * 60 + 45; // 2:45
const MAX_DURATION_S = 3 * 60 + 30; // 3:30

// Umbrales de calidad de audio
const CLIP_SAMPLE_THRESHOLD = 50; // muestras clippeadas por debajo de esto = ruido normal
const ABRUPT_CUTOFF_DROP_DB = 6; // un fade-out natural cae más de esto en el último medio segundo
const VOCAL_SILENCE_DB = -50; // mean_volume por debajo de esto = "sin voz" (instrumental accidental)

// ─── Helpers de proceso ───────────────────────────────────────────────────────

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf-8', timeout: 30000, maxBuffer: 10 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// ─── ffprobe / ffmpeg ─────────────────────────────────────────────────────────

// Devuelve la duración en segundos, o null si ffprobe no está disponible/falla.
function getDuration(mp3Path) {
  try {
    const result = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', mp3Path],
      { encoding: 'utf-8', timeout: 15000 }
    );
    if (result.status !== 0 || !result.stdout) return null;
    const secs = parseFloat(result.stdout.trim());
    return isNaN(secs) ? null : secs;
  } catch {
    return null;
  }
}

// Versión async de getDuration, para poder correr A y B en paralelo (Promise.all).
async function getDurationAsync(mp3Path) {
  const { error, stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', mp3Path,
  ]);
  if (error) return null;
  const secs = parseFloat(stdout.trim());
  return isNaN(secs) ? null : secs;
}

function formatDuration(secs) {
  if (secs === null || secs === undefined) return '?:??';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Formatea una duración en milisegundos como "Xm Ys" (o "Xs" si dura menos de 1 min).
function formatElapsed(ms) {
  if (ms === null || ms === undefined) return '?';
  const totalS = Math.round(ms / 1000);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// Mean volume (dB) de un tramo del audio, vía el filtro volumedetect de ffmpeg.
// Devuelve null si ffmpeg no está disponible o falla.
async function getMeanVolumeDb(mp3Path, { start, duration } = {}) {
  const args = ['-hide_banner'];
  if (start !== undefined) args.push('-ss', String(Math.max(0, start)));
  if (duration !== undefined) args.push('-t', String(duration));
  args.push('-i', mp3Path, '-af', 'volumedetect', '-f', 'null', '-');
  const { error, stderr } = await execFileAsync('ffmpeg', args, { timeout: 30000 });
  if (error) return null;
  const m = stderr.match(/mean_volume:\s*(-?\d+(\.\d+)?)\s*dB/);
  return m ? parseFloat(m[1]) : null;
}

// Corte abrupto: compara el volumen del cuerpo de los últimos 5s contra el
// último medio segundo. Un fade-out natural cae fuerte al final; si casi no
// cae, el corte es abrupto. Devuelve true/false, o null si no se pudo medir.
async function detectAbruptCutoff(mp3Path, duration) {
  if (!duration || duration < 6) return null;
  const [bodyVol, tailVol] = await Promise.all([
    getMeanVolumeDb(mp3Path, { start: duration - 5, duration: 4.5 }),
    getMeanVolumeDb(mp3Path, { start: duration - 0.5, duration: 0.5 }),
  ]);
  if (bodyVol === null || tailVol === null) return null;
  const drop = bodyVol - tailVol; // positivo = el final es más silencioso
  return drop < ABRUPT_CUTOFF_DROP_DB;
}

// Cuenta muestras clippeadas (astats de ffmpeg). Devuelve null si no se pudo medir.
async function detectClipping(mp3Path) {
  const { error, stderr } = await execFileAsync(
    'ffmpeg',
    ['-hide_banner', '-i', mp3Path, '-af', 'astats=metadata=0', '-f', 'null', '-'],
    { timeout: 30000 }
  );
  if (error) return null;
  const matches = [...stderr.matchAll(/Number of clipped samples:\s*(\d+)/g)];
  if (!matches.length) return null;
  return matches.reduce((sum, m) => sum + parseInt(m[1], 10), 0);
}

// ─── demucs (separación de voz, opcional) ─────────────────────────────────────

// Corre demucs CLI (modelo htdemucs_ft) y devuelve la ruta al vocals.wav aislado.
// Lanza Error descriptivo si demucs no está instalado o falla.
function runDemucsSeparate(mp3Path, outDir) {
  const result = spawnSync('demucs', ['-n', 'htdemucs_ft', '--two-stems', 'vocals', '-o', outDir, mp3Path], {
    encoding: 'utf-8',
    timeout: 10 * 60 * 1000,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error('demucs no está instalado. Corré: pip install demucs');
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`demucs falló: ${(result.stderr || '').substring(0, 300)}`);
  }
  const base = path.basename(mp3Path, path.extname(mp3Path));
  const vocalsPath = path.join(outDir, 'htdemucs_ft', base, 'vocals.wav');
  if (!fs.existsSync(vocalsPath)) {
    throw new Error(`demucs no generó el archivo esperado: ${vocalsPath}`);
  }
  return vocalsPath;
}

// ─── Texto de referencia de song.txt ─────────────────────────────────────────

function parseLyricsFromSongFile(content) {
  const verseIndex = content.search(/\[Verse 1\]/i);
  const advertIndex = content.search(/\*\*Advertencias:\*\*/i);
  const notesIndex = content.search(/NOTES:/i);
  const endIndex = [advertIndex, notesIndex].filter((i) => i !== -1).sort((a, b) => a - b)[0];
  if (verseIndex === -1) return null;
  return content.slice(verseIndex, endIndex !== undefined ? endIndex : undefined).trim();
}

function parseTituloFromSongFile(content) {
  return (content.match(/\*\*Título:\*\*\s*(.+)/i) || [])[1]?.trim() || null;
}

// Tags estructurales presentes en la letra, ej. ["Verse 1", "Chorus 1", ...].
function extractStructuralTags(lyricsText) {
  return [...String(lyricsText || '').matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim());
}

// Letra sin las líneas de tags — usada como initial_prompt de Whisper y para
// la comparación de contenido (nunca se compara contra los tags en sí).
function stripStructuralTags(lyricsText) {
  return String(lyricsText || '')
    .split('\n')
    .filter((l) => !/^\s*\[[^\]]+\]\s*$/.test(l))
    .join('\n')
    .trim();
}

// ─── Comparación letra vs transcripción (Levenshtein) ────────────────────────

function normalizeForCompare(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Similitud 0..1 entre dos textos, basada en distancia de Levenshtein
// (ignora may/min y puntuación).
function levenshteinSimilarity(a, b) {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (!na || !nb) return 0;
  const d = distance(na, nb);
  return 1 - d / Math.max(na.length, nb.length);
}

// Verifica si un nombre de destinatario está presente en la transcripción
// de forma exacta o difusa (coincidencia de Levenshtein > 0.8 en alguna palabra).
function isNameInTranscription(name, transcribedText) {
  const normName = normalizeForCompare(name);
  const normTrans = normalizeForCompare(transcribedText);
  if (!normName || !normTrans) return false;
  if (normTrans.includes(normName)) return true;

  const words = normTrans.split(/\s+/);
  for (const w of words) {
    if (w.length > 1 && levenshteinSimilarity(normName, w) > 0.8) {
      return true;
    }
  }
  return false;
}

// Compara el texto transcripto contra las líneas de la letra (sin tags).
// Devuelve lista de problemas con timestamp del segmento más parecido (si hay).
function compareTranscriptionToLyrics(transcribedText, lyricsText, segments = []) {
  const lyricsLines = lyricsText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('['));

  const sentences = transcribedText.split(/[.,!?;]/).filter(Boolean);
  const problems = [];

  for (const line of lyricsLines) {
    if (line.length < 8) continue;
    const bestScore = Math.max(...sentences.map((s) => levenshteinSimilarity(line, s)), 0);
    if (bestScore < 0.4) {
      let bestSeg = null;
      let bestSegScore = 0;
      for (const seg of segments) {
        const score = levenshteinSimilarity(line, seg.text);
        if (score > bestSegScore) {
          bestSegScore = score;
          bestSeg = seg;
        }
      }
      problems.push({ line, score: bestScore, timestamp: bestSeg ? bestSeg.start : null });
    }
  }

  return problems;
}

// Tag leaking: ¿el AI cantó literalmente alguna palabra de tag estructural?
const TAG_LEAK_BASE_WORDS = ['verse', 'chorus', 'bridge', 'outro', 'coro', 'verso'];

function tagLeakKeywords(tags) {
  const fromTags = tags.map((t) => t.toLowerCase().replace(/\s*\d+$/, '').trim()).filter(Boolean);
  return [...new Set([...TAG_LEAK_BASE_WORDS, ...fromTags])];
}

function detectTagLeaking(transcribedText, keywords) {
  const norm = normalizeForCompare(transcribedText);
  return keywords.filter((w) => new RegExp(`\\b${w}\\b`).test(norm));
}

// ─── Análisis completo de un MP3 ─────────────────────────────────────────────

// Devuelve un objeto con el reporte de análisis.
// label: "Versión A" o "Versión B"
// mp3Path: ruta absoluta al .mp3
// titulo: título de la canción (para check de título cantado)
// lyricsText: texto de la letra (para comparación)
// useDemucs: si true, separa voz con demucs (htdemucs_ft) antes de transcribir
//   y usa Whisper large-v3/CUDA con initial_prompt. Si false (default),
//   comportamiento idéntico al de siempre (Whisper small/CPU sobre el MP3 completo).
// duration: si ya se calculó (ver getDurationAsync en paralelo), se puede pasar
//   para no recalcularla.
async function analyzeAudio(mp3Path, { label = 'Versión', titulo = '', lyricsText = '', useDemucs = false, duration = undefined, firstNames = [] } = {}) {
  const report = {
    label,
    file: path.basename(mp3Path),
    duration: null,
    durationFormatted: '?:??',
    durationOk: null,
    abruptCutoff: null,
    clippingCount: null,
    clippingFlag: false,
    transcription: null,
    transcriptionError: null,
    titleCantado: null,
    lyricsIssues: [],
    levenshteinScore: null,
    tagLeaking: [],
    missingNames: [],
    demucs: { used: false, vocalPresence: null, error: null },
    timing: { demucsMs: null, whisperMs: null, totalMs: null },
    summary: '',
  };

  const analyzeStart = Date.now();
  const cleanLyrics = stripStructuralTags(lyricsText);
  const tags = extractStructuralTags(lyricsText);

  // 1. Duración + chequeos de calidad de audio (ffmpeg, en paralelo)
  report.duration = duration !== undefined ? duration : await getDurationAsync(mp3Path);
  report.durationFormatted = formatDuration(report.duration);
  if (report.duration !== null) {
    report.durationOk = report.duration >= MIN_DURATION_S && report.duration <= MAX_DURATION_S;
  }

  const [abruptCutoff, clippingCount] = await Promise.all([
    detectAbruptCutoff(mp3Path, report.duration),
    detectClipping(mp3Path),
  ]);
  report.abruptCutoff = abruptCutoff;
  report.clippingCount = clippingCount;
  report.clippingFlag = clippingCount !== null && clippingCount > CLIP_SAMPLE_THRESHOLD;

  // 2. Separación de voz (demucs, opcional) + transcripción
  let transcribeTargetPath = mp3Path;
  let demucsTmpDir = null;

  try {
    if (useDemucs) {
      const demucsStart = Date.now();
      demucsTmpDir = path.join(os.tmpdir(), `cancioneterna-demucs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      try {
        const vocalsPath = runDemucsSeparate(mp3Path, demucsTmpDir);
        transcribeTargetPath = vocalsPath;
        report.demucs.used = true;
        const vol = await getMeanVolumeDb(vocalsPath);
        report.demucs.vocalPresence = vol === null ? null : vol < VOCAL_SILENCE_DB;
      } catch (e) {
        report.demucs.error = e.message;
        console.warn(`⚠️  demucs no disponible/falló, transcribiendo el MP3 completo: ${e.message}`);
      } finally {
        report.timing.demucsMs = Date.now() - demucsStart;
      }
    }

    let transcribedText = '';
    if (fs.existsSync(TRANSCRIBE_SCRIPT)) {
      const whisperStart = Date.now();
      try {
        const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
        const pythonArgs = [TRANSCRIBE_SCRIPT, transcribeTargetPath, useDemucs ? 'large-v3' : 'small'];
        if (useDemucs) {
          pythonArgs.push('--device', 'cuda');
          if (cleanLyrics) pythonArgs.push('--initial-prompt', cleanLyrics);
        }
        const result = spawnSync(pythonCmd, pythonArgs, {
          encoding: 'utf-8',
          timeout: (useDemucs ? 10 : 5) * 60 * 1000,
          maxBuffer: 10 * 1024 * 1024,
        });
        report.timing.whisperMs = Date.now() - whisperStart;
        if (result.stderr && result.stderr.trim()) {
          console.warn(`   ${result.stderr.trim().split('\n')[0]}`);
        }
        if (result.stdout) {
          try {
            const parsed = JSON.parse(result.stdout.trim().split('\n').pop());
            if (parsed.error) {
              report.transcriptionError = parsed.error;
            } else {
              report.transcription = parsed;
              transcribedText = parsed.text || '';
            }
          } catch {
            report.transcriptionError = 'No se pudo parsear la salida de Whisper.';
          }
        } else if (result.stderr) {
          report.transcriptionError = `Whisper stderr: ${result.stderr.substring(0, 200)}`;
        } else {
          report.transcriptionError = 'Whisper no produjo salida.';
        }
      } catch (e) {
        report.timing.whisperMs = Date.now() - whisperStart;
        report.transcriptionError = e.message;
      }
    } else {
      report.transcriptionError = `setup-whisper.js no corrió aún o transcribe.py no existe en ${TRANSCRIBE_SCRIPT}`;
    }

    // 3. Título cantado (check)
    if (transcribedText && titulo) {
      const titleNorm = normalizeForCompare(titulo);
      const transcNorm = normalizeForCompare(transcribedText);
      report.titleCantado = transcNorm.includes(titleNorm.substring(0, Math.min(titleNorm.length, 20)));
    }

    // 4. Comparación letra (Levenshtein) + tag leaking
    if (transcribedText && cleanLyrics) {
      const segments = report.transcription?.segments || [];
      report.lyricsIssues = compareTranscriptionToLyrics(transcribedText, cleanLyrics, segments);
      report.levenshteinScore = levenshteinSimilarity(cleanLyrics, transcribedText);
    }
    if (transcribedText) {
      report.tagLeaking = detectTagLeaking(transcribedText, tagLeakKeywords(tags));
      if (firstNames && firstNames.length > 0) {
        report.missingNames = firstNames.filter((name) => !isNameInTranscription(name, transcribedText));
      }
    }
  } finally {
    if (demucsTmpDir && fs.existsSync(demucsTmpDir)) {
      try {
        fs.rmSync(demucsTmpDir, { recursive: true, force: true });
      } catch {
        // best-effort — no debe romper el pipeline por un temp que no se pudo borrar
      }
    }
    report.timing.totalMs = Date.now() - analyzeStart;
  }

  // 5. Resumen
  const flags = [];
  if (report.durationOk === false) {
    flags.push(`${report.durationFormatted} ⚠️ fuera de rango 2:45–3:30`);
  } else if (report.durationOk === true) {
    flags.push(`${report.durationFormatted} ✓`);
  } else {
    flags.push('duración: ? (ffprobe no disponible)');
  }

  if (report.abruptCutoff === true) {
    flags.push('final abrupto ⚠️ (sin fade-out)');
  } else if (report.abruptCutoff === false) {
    flags.push('fade-out ✓');
  }

  if (report.clippingFlag) {
    flags.push(`clipping ⚠️ (${report.clippingCount} muestras)`);
  }

  if (report.transcriptionError) {
    flags.push(`transcripción: no disponible (${report.transcriptionError.substring(0, 60)})`);
  } else {
    if (report.levenshteinScore !== null && report.levenshteinScore < 0.75) {
      flags.push(`ALUCINACIÓN GRAVE ⚠️ (Similitud baja ${Math.round(report.levenshteinScore * 100)}% < 75%)`);
    } else if (report.lyricsIssues.length > 0) {
      flags.push(`letra: ${report.lyricsIssues.length} líneas posiblemente mal cantadas ⚠️`);
    } else if (report.levenshteinScore !== null) {
      flags.push(`letra: coincide ✓ (Levenshtein ${Math.round(report.levenshteinScore * 100)}%)`);
    }
  }

  if (report.titleCantado === true) {
    flags.push('título cantado ⚠️ (revisar)');
  } else if (report.titleCantado === false) {
    flags.push('título no cantado ✓');
  }

  if (report.tagLeaking.length > 0) {
    flags.push(`tags de estructura cantados ⚠️ (${report.tagLeaking.join(', ')})`);
  }

  if (report.missingNames.length > 0) {
    flags.push(`nombres ausentes ⚠️ (${report.missingNames.join(', ')})`);
  }

  if (report.demucs.used) {
    if (report.demucs.vocalPresence === true) {
      flags.push('⚠️ instrumental accidental (sin voz detectada tras aislar)');
    } else if (report.demucs.vocalPresence === false) {
      flags.push('voz aislada ✓');
    }
  } else if (report.demucs.error) {
    flags.push('demucs: omitido (no disponible)');
  }

  const hasIssues =
    report.durationOk === false ||
    report.abruptCutoff === true ||
    report.clippingFlag ||
    (report.levenshteinScore !== null && report.levenshteinScore < 0.75) ||
    report.lyricsIssues.length > 0 ||
    report.titleCantado === true ||
    report.tagLeaking.length > 0 ||
    report.missingNames.length > 0 ||
    report.demucs.vocalPresence === true;

  report.summary = `${label} (${path.basename(mp3Path)}): ${flags.join(' | ')} → ${hasIssues ? 'REVISAR' : 'SIN PROBLEMAS'}`;

  return report;
}

// ─── Formateo de reporte completo ────────────────────────────────────────────

function printReport(titulo, reportA, reportB) {
  console.log('\n══════════════════════════════════════════════════════');
  console.log(`🎵 Canción: ${titulo}`);
  console.log('══════════════════════════════════════════════════════');

  for (const report of [reportA, reportB].filter(Boolean)) {
    console.log(`\n${report.summary}`);

    if (report.transcriptionError) {
      console.log(`   ⚠️ Transcripción no disponible: ${report.transcriptionError}`);
    }

    if (report.demucs.error) {
      console.log(`   ⚠️ demucs: ${report.demucs.error}`);
    }

    if (report.missingNames && report.missingNames.length > 0) {
      console.log(`   ⚠️  Nombres de destinatarios no detectados en audio: ${report.missingNames.join(', ')} (verificar manualmente)`);
    }

    if (report.lyricsIssues.length > 0) {
      console.log(`   Líneas posiblemente mal cantadas (Whisper puede fallar con canto — confirmá con tu oído):`);
      for (const issue of report.lyricsIssues.slice(0, 5)) {
        const ts = issue.timestamp !== null && issue.timestamp !== undefined
          ? ` @${Math.floor(issue.timestamp / 60)}:${String(Math.floor(issue.timestamp % 60)).padStart(2, '0')}`
          : '';
        console.log(`     • "${issue.line}"${ts} (similitud: ${Math.round(issue.score * 100)}%)`);
      }
      if (report.lyricsIssues.length > 5) {
        console.log(`     ... y ${report.lyricsIssues.length - 5} más`);
      }
    }

    if (report.transcription && report.transcription.segments) {
      console.log(`   Transcripción completa (Whisper, solo referencial):`);
      for (const seg of report.transcription.segments.slice(0, 8)) {
        const start = `${Math.floor(seg.start / 60)}:${String(Math.floor(seg.start % 60)).padStart(2, '0')}`;
        console.log(`     [${start}] ${seg.text}`);
      }
      if (report.transcription.segments.length > 8) {
        console.log(`     ... (${report.transcription.segments.length - 8} segmentos más)`);
      }
    }

    const t = report.timing;
    const timingParts = [];
    if (t.demucsMs !== null) timingParts.push(`demucs ${formatElapsed(t.demucsMs)}`);
    if (t.whisperMs !== null) timingParts.push(`whisper ${formatElapsed(t.whisperMs)}`);
    if (timingParts.length > 0) {
      console.log(`   ⏱️  Tiempo: ${timingParts.join(' + ')} → total ${formatElapsed(t.totalMs)}`);
    }
  }

  const combinedMs = [reportA, reportB].filter(Boolean).reduce((sum, r) => sum + (r.timing.totalMs || 0), 0);
  console.log(`\n⏱️  Tiempo total del análisis (A${reportB ? ' + B' : ''}): ${formatElapsed(combinedMs)}`);

  console.log('\n──────────────────────────────────────────────────────');
  console.log('👉 Estas marcas son ORIENTATIVAS. Confirmá siempre con tu oído.');
  console.log('   Whisper sobre canto vocal puede tener muchos errores — no lo uses para decidir solo.');
  console.log('──────────────────────────────────────────────────────\n');
}

module.exports = {
  analyzeAudio,
  printReport,
  getDuration,
  getDurationAsync,
  formatDuration,
  formatElapsed,
  SONG_PATH,
  parseLyricsFromSongFile,
  parseTituloFromSongFile,
  stripStructuralTags,
  extractStructuralTags,
};
