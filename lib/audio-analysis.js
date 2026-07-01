// lib/audio-analysis.js — Análisis de MP3: duración (ffprobe) + transcripción
// (Whisper via Python) + comparación contra song.txt.
//
// INFORMA, no decide. Nunca sube nada, nunca elige versión.
// Whisper sobre canto da falsos positivos — siempre aclararlo en la salida.

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SONG_PATH = path.join(__dirname, '..', 'song.txt');
const TRANSCRIBE_SCRIPT = path.join(__dirname, 'transcribe.py');

// Duración ideal de una canción (segundos)
const MIN_DURATION_S = 2 * 60 + 45; // 2:45
const MAX_DURATION_S = 3 * 60 + 30; // 3:30

// ─── ffprobe ──────────────────────────────────────────────────────────────────

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

function formatDuration(secs) {
  if (secs === null) return '?:??';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
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

// ─── Comparación letra vs transcripción ──────────────────────────────────────

function normalizeForCompare(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Devuelve qué tan parecidas son dos líneas (fracción de palabras en común).
function lineSimilarity(a, b) {
  const wa = new Set(normalizeForCompare(a).split(' ').filter((w) => w.length > 2));
  const wb = new Set(normalizeForCompare(b).split(' ').filter((w) => w.length > 2));
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.max(wa.size, wb.size);
}

// Compara el texto transcripto contra las líneas de la letra.
// Devuelve lista de problemas (puede ser vacía).
function compareTranscriptionToLyrics(transcribedText, lyricsText) {
  const lyricsLines = lyricsText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('['));

  const transcribedNorm = normalizeForCompare(transcribedText);

  const problems = [];

  for (const line of lyricsLines) {
    const lineNorm = normalizeForCompare(line);
    if (!lineNorm || lineNorm.length < 8) continue;
    if (!transcribedNorm.includes(lineNorm.substring(0, 12))) {
      // La línea no aparece ni aproximadamente — verificar con similitud
      const sentences = transcribedText.split(/[.,!?;]/);
      const bestScore = Math.max(...sentences.map((s) => lineSimilarity(line, s)), 0);
      if (bestScore < 0.4) {
        problems.push({ line, score: bestScore });
      }
    }
  }

  return problems;
}

// ─── Análisis completo de un MP3 ─────────────────────────────────────────────

// Devuelve un objeto con el reporte de análisis.
// label: "Versión A" o "Versión B"
// mp3Path: ruta absoluta al .mp3
// titulo: título de la canción (para check de título cantado)
// lyricsText: texto de la letra (para comparación)
async function analyzeAudio(mp3Path, { label = 'Versión', titulo = '', lyricsText = '' } = {}) {
  const report = {
    label,
    file: path.basename(mp3Path),
    duration: null,
    durationFormatted: '?:??',
    durationOk: null,
    transcription: null,
    transcriptionError: null,
    titleCantado: null,
    lyricsIssues: [],
    summary: '',
  };

  // 1. Duración
  report.duration = getDuration(mp3Path);
  report.durationFormatted = formatDuration(report.duration);
  if (report.duration !== null) {
    report.durationOk = report.duration >= MIN_DURATION_S && report.duration <= MAX_DURATION_S;
  }

  // 2. Transcripción
  let transcribedText = '';
  if (fs.existsSync(TRANSCRIBE_SCRIPT)) {
    try {
      const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
      const result = spawnSync(pythonCmd, [TRANSCRIBE_SCRIPT, mp3Path, 'small'], {
        encoding: 'utf-8',
        timeout: 5 * 60 * 1000, // 5 minutos max
        maxBuffer: 10 * 1024 * 1024,
      });
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

  // 4. Comparación letra
  if (transcribedText && lyricsText) {
    report.lyricsIssues = compareTranscriptionToLyrics(transcribedText, lyricsText);
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

  if (report.transcriptionError) {
    flags.push(`transcripción: no disponible (${report.transcriptionError.substring(0, 60)})`);
  } else if (report.lyricsIssues.length > 0) {
    flags.push(`letra: ${report.lyricsIssues.length} líneas posiblemente mal cantadas ⚠️`);
  } else if (transcribedText) {
    flags.push('letra: coincide ✓');
  }

  if (report.titleCantado === true) {
    flags.push('título cantado ⚠️ (revisar)');
  } else if (report.titleCantado === false) {
    flags.push('título no cantado ✓');
  }

  const hasIssues =
    report.durationOk === false ||
    report.lyricsIssues.length > 0 ||
    report.titleCantado === true;

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

    if (report.lyricsIssues.length > 0) {
      console.log(`   Líneas posiblemente mal cantadas (Whisper puede fallar con canto — confirmá con tu oído):`);
      for (const issue of report.lyricsIssues.slice(0, 5)) {
        console.log(`     • "${issue.line}" (similitud: ${Math.round(issue.score * 100)}%)`);
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
  }

  console.log('\n──────────────────────────────────────────────────────');
  console.log('👉 Estas marcas son ORIENTATIVAS. Confirmá siempre con tu oído.');
  console.log('   Whisper sobre canto vocal puede tener muchos errores — no lo uses para decidir solo.');
  console.log('──────────────────────────────────────────────────────\n');
}

module.exports = { analyzeAudio, printReport, getDuration, formatDuration, SONG_PATH, parseLyricsFromSongFile, parseTituloFromSongFile };
