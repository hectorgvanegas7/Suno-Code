// lib/audio-analysis.js — Análisis de MP3: duración (ffprobe) + calidad de audio
// (corte abrupto, clipping) + transcripción (Whisper via Python) + comparación
// contra song.txt (Levenshtein) + separación de voz opcional (demucs) +
// evaluación perceptual con CLAP (calidad vocal, producción, emoción, artefactos).
//
// INFORMA, no decide. Nunca sube nada, nunca elige versión.
// Whisper sobre canto da falsos positivos — siempre aclararlo en la salida.
// CLAP es una señal informativa nueva (±15 pts) — no decide solo.
//
// Instalación de dependencias avanzadas (opcionales, degradan con gracia si faltan):
//   npm install fastest-levenshtein
//   pip install faster-whisper
//   pip install torch --index-url https://download.pytorch.org/whl/cu124
//   pip install torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124
//   pip install soundfile
//   pip install demucs      (opcional — solo hace falta para --demucs)
//   pip install transformers librosa   (opcional — solo hace falta para CLAP)

const { spawnSync, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { distance } = require('fastest-levenshtein');

const SONG_PATH = path.join(__dirname, '..', 'song.txt');
const TRANSCRIBE_SCRIPT = path.join(__dirname, 'transcribe.py');
const CLAP_SCRIPT = path.join(__dirname, 'clap_score.py');

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

// ─── Preparación de voz (demucs) + transcripción, reutilizables ──────────────

// Separa la voz de un MP3 con demucs (si useDemucs). Devuelve:
//   { targetPath, tmpDir, demucs: {used, vocalPresence, error}, demucsMs }
// targetPath = vocals.wav aislado, o el MP3 original si demucs no corrió/falló.
// El caller es dueño de tmpDir — limpiarlo con cleanupVocalsTmp() después de
// transcribir. analyzeAudio lo usa internamente; verify-audio.js lo usa por
// separado para poder batchear la transcripción de A y B.
async function prepareVocals(mp3Path, useDemucs) {
  const prep = {
    targetPath: mp3Path,
    tmpDir: null,
    demucs: { used: false, vocalPresence: null, error: null },
    demucsMs: null,
  };
  if (!useDemucs) return prep;

  const demucsStart = Date.now();
  prep.tmpDir = path.join(os.tmpdir(), `cancioneterna-demucs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    const vocalsPath = runDemucsSeparate(mp3Path, prep.tmpDir);
    prep.targetPath = vocalsPath;
    prep.demucs.used = true;
    const vol = await getMeanVolumeDb(vocalsPath);
    prep.demucs.vocalPresence = vol === null ? null : vol < VOCAL_SILENCE_DB;
  } catch (e) {
    prep.demucs.error = e.message;
    console.warn(`⚠️  demucs no disponible/falló, transcribiendo el MP3 completo: ${e.message}`);
  } finally {
    prep.demucsMs = Date.now() - demucsStart;
  }
  return prep;
}

function cleanupVocalsTmp(prep) {
  if (prep && prep.tmpDir && fs.existsSync(prep.tmpDir)) {
    try {
      fs.rmSync(prep.tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort — no debe romper el pipeline por un temp que no se pudo borrar
    }
  }
}

// Transcribe uno o más audios con UNA sola invocación de transcribe.py — el
// modelo Whisper se carga una única vez (cargar large-v3 en CUDA tarda decenas
// de segundos; batchear A y B evita pagar esa carga dos veces).
// Devuelve { results: [{parsed, error, elapsedMs}], whisperMs } — un result por
// path, en el mismo orden. Nunca lanza.
function transcribeFiles(paths, { model = 'small', device = null, initialPrompt = null } = {}) {
  const outcome = { results: paths.map(() => ({ parsed: null, error: null, elapsedMs: null })), whisperMs: null };

  if (!fs.existsSync(TRANSCRIBE_SCRIPT)) {
    const msg = `setup-whisper.js no corrió aún o transcribe.py no existe en ${TRANSCRIBE_SCRIPT}`;
    outcome.results.forEach((r) => { r.error = msg; });
    return outcome;
  }

  const whisperStart = Date.now();
  try {
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const pythonArgs = [TRANSCRIBE_SCRIPT, ...paths, model];
    if (device) pythonArgs.push('--device', device);
    if (initialPrompt) pythonArgs.push('--initial-prompt', initialPrompt);

    const perFileTimeoutMin = model === 'small' ? 5 : 10;
    const result = spawnSync(pythonCmd, pythonArgs, {
      encoding: 'utf-8',
      timeout: perFileTimeoutMin * 60 * 1000 * paths.length,
      maxBuffer: 10 * 1024 * 1024,
    });
    outcome.whisperMs = Date.now() - whisperStart;

    if (result.stderr && result.stderr.trim()) {
      console.warn(`   ${result.stderr.trim().split('\n')[0]}`);
    }
    if (!result.stdout) {
      const msg = result.stderr
        ? `Whisper stderr: ${result.stderr.substring(0, 200)}`
        : 'Whisper no produjo salida.';
      outcome.results.forEach((r) => { r.error = msg; });
      return outcome;
    }

    let parsed;
    try {
      parsed = JSON.parse(result.stdout.trim().split('\n').pop());
    } catch {
      outcome.results.forEach((r) => { r.error = 'No se pudo parsear la salida de Whisper.'; });
      return outcome;
    }

    // 1 archivo → objeto único (formato histórico); N → { batch, results: [...] }
    const perFile = parsed.batch ? parsed.results : [parsed];
    for (let i = 0; i < outcome.results.length; i++) {
      const p = perFile[i];
      if (!p) {
        outcome.results[i].error = 'Whisper no devolvió resultado para este archivo.';
        continue;
      }
      outcome.results[i].elapsedMs = p.elapsed_ms ?? null;
      if (p.error) outcome.results[i].error = p.error;
      else outcome.results[i].parsed = p;
    }
  } catch (e) {
    if (outcome.whisperMs === null) outcome.whisperMs = Date.now() - whisperStart;
    outcome.results.forEach((r) => { if (!r.error && !r.parsed) r.error = e.message; });
  }
  return outcome;
}

// ─── CLAP — evaluación perceptual de calidad de audio ────────────────────────

// Corre lib/clap_score.py sobre uno o más MP3 y devuelve los scores CLAP.
// Mismo patrón que transcribeFiles(): spawnSync → parse JSON → graceful degrade.
// Devuelve { results: [{clapScore, dimensions, error, elapsedMs}], clapMs }.
// Nunca lanza — si CLAP no está instalado o falla, el error queda por resultado.
function runClapScore(mp3Paths, { device = null } = {}) {
  const outcome = {
    results: mp3Paths.map(() => ({ clapScore: null, dimensions: null, error: null, elapsedMs: null })),
    clapMs: null,
  };

  if (!fs.existsSync(CLAP_SCRIPT)) {
    const msg = `clap_score.py no existe en ${CLAP_SCRIPT}`;
    outcome.results.forEach((r) => { r.error = msg; });
    return outcome;
  }

  const clapStart = Date.now();
  try {
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const pythonArgs = [CLAP_SCRIPT, ...mp3Paths];
    if (device) pythonArgs.push('--device', device);

    // Timeout: 3 min por archivo (CLAP es más rápido que Whisper, pero la
    // primera corrida descarga el modelo ~300MB)
    const result = spawnSync(pythonCmd, pythonArgs, {
      encoding: 'utf-8',
      timeout: 3 * 60 * 1000 * mp3Paths.length,
      maxBuffer: 10 * 1024 * 1024,
    });
    outcome.clapMs = Date.now() - clapStart;

    if (result.stderr && result.stderr.trim()) {
      // CLAP manda info útil a stderr (ej. "CLAP cargado en CUDA")
      const lines = result.stderr.trim().split('\n');
      for (const line of lines.slice(0, 3)) {
        console.log(`   [CLAP] ${line.trim()}`);
      }
    }
    if (!result.stdout) {
      const msg = result.stderr
        ? `CLAP stderr: ${result.stderr.substring(0, 200)}`
        : 'CLAP no produjo salida.';
      outcome.results.forEach((r) => { r.error = msg; });
      return outcome;
    }

    let parsed;
    try {
      parsed = JSON.parse(result.stdout.trim().split('\n').pop());
    } catch {
      outcome.results.forEach((r) => { r.error = 'No se pudo parsear la salida de CLAP.'; });
      return outcome;
    }

    // Error global del script (ej. dependencias faltantes)
    if (parsed.error && !parsed.batch) {
      outcome.results.forEach((r) => { r.error = parsed.error; });
      return outcome;
    }

    // 1 archivo → objeto único; N → { batch, results: [...] }
    const perFile = parsed.batch ? parsed.results : [parsed];
    for (let i = 0; i < outcome.results.length; i++) {
      const p = perFile[i];
      if (!p) {
        outcome.results[i].error = 'CLAP no devolvió resultado para este archivo.';
        continue;
      }
      outcome.results[i].elapsedMs = p.elapsed_ms ?? null;
      if (p.error) {
        outcome.results[i].error = p.error;
      } else {
        outcome.results[i].clapScore = p.clap_score ?? null;
        outcome.results[i].dimensions = p.dimensions ?? null;
      }
    }
  } catch (e) {
    if (outcome.clapMs === null) outcome.clapMs = Date.now() - clapStart;
    outcome.results.forEach((r) => { if (!r.error && r.clapScore === null) r.error = e.message; });
  }
  return outcome;
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
// prepared / transcriptionOutcome: resultados ya computados afuera (camino
//   batcheado de verify-audio.js — demucs por versión + UNA sola carga de
//   Whisper para A y B). Si se pasan, acá no se corre demucs ni Whisper y el
//   caller es dueño de la limpieza del tmp de demucs.
async function analyzeAudio(mp3Path, { label = 'Versión', titulo = '', lyricsText = '', useDemucs = false, duration = undefined, firstNames = [], prepared = null, transcriptionOutcome = null, clapOutcome = null } = {}) {
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
    clap: { score: null, dimensions: null, error: null },
    demucs: { used: false, vocalPresence: null, error: null },
    timing: { demucsMs: null, whisperMs: null, clapMs: null, totalMs: null },
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

  // 2. Separación de voz (demucs, opcional) + transcripción.
  // Si el caller ya los computó (camino batcheado), acá solo se anotan.
  let ownedPrep = null; // solo si la separación se hizo acá adentro → limpieza propia

  try {
    let prep = prepared;
    if (!prep) {
      prep = await prepareVocals(mp3Path, useDemucs);
      ownedPrep = prep;
    }
    report.demucs = prep.demucs;
    report.timing.demucsMs = prep.demucsMs;

    let trans = transcriptionOutcome;
    if (!trans) {
      const batch = transcribeFiles([prep.targetPath], {
        model: useDemucs ? 'large-v3' : 'small',
        device: useDemucs ? 'cuda' : null,
        initialPrompt: useDemucs && cleanLyrics ? cleanLyrics : null,
      });
      trans = { ...batch.results[0], whisperMs: batch.whisperMs };
    }
    report.timing.whisperMs = trans.whisperMs ?? trans.elapsedMs ?? null;

    let transcribedText = '';
    if (trans.error) {
      report.transcriptionError = trans.error;
    } else if (trans.parsed) {
      report.transcription = trans.parsed;
      transcribedText = trans.parsed.text || '';
    } else {
      report.transcriptionError = 'Whisper no produjo salida.';
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
    cleanupVocalsTmp(ownedPrep); // el tmp de un `prepared` externo lo limpia el caller
  }

  // 5b. CLAP — evaluación perceptual de calidad de audio
  if (clapOutcome) {
    // Resultado pre-computado (camino batcheado de verify-audio.js)
    if (clapOutcome.error) {
      report.clap.error = clapOutcome.error;
    } else {
      report.clap.score = clapOutcome.clapScore ?? null;
      report.clap.dimensions = clapOutcome.dimensions ?? null;
    }
    report.timing.clapMs = clapOutcome.elapsedMs ?? null;
  } else {
    // Correr CLAP inline (camino de 1 sola versión)
    const clapResult = runClapScore([mp3Path], { device: useDemucs ? 'cuda' : null });
    const cr = clapResult.results[0];
    if (cr.error) {
      report.clap.error = cr.error;
    } else {
      report.clap.score = cr.clapScore ?? null;
      report.clap.dimensions = cr.dimensions ?? null;
    }
    report.timing.clapMs = cr.elapsedMs ?? clapResult.clapMs ?? null;
  }

  report.timing.totalMs = Date.now() - analyzeStart;

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

  if (report.clap.score !== null) {
    const cs = report.clap.score;
    if (cs >= 75) flags.push(`CLAP: ${cs}/100 ✓`);
    else if (cs >= 50) flags.push(`CLAP: ${cs}/100 ⚠️ (mediocre)`);
    else flags.push(`CLAP: ${cs}/100 ⚠️ (baja calidad)`);
  } else if (report.clap.error) {
    flags.push('CLAP: no disponible');
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
    report.demucs.vocalPresence === true ||
    (report.clap.score !== null && report.clap.score < 50);

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

    // CLAP scores detallados por dimensión
    if (report.clap.score !== null && report.clap.dimensions) {
      const d = report.clap.dimensions;
      const dimLabels = {
        vocal_clarity: 'Claridad vocal',
        production: 'Producción',
        emotion: 'Emoción',
        artifacts: 'Artefactos',
        ending: 'Final',
      };
      const parts = Object.entries(d).map(([k, v]) => `${dimLabels[k] || k}: ${v}`).join(' | ');
      console.log(`   🎧 CLAP score: ${report.clap.score}/100 — ${parts}`);
    } else if (report.clap.error) {
      console.log(`   🎧 CLAP: no disponible (${report.clap.error.substring(0, 60)})`);
    }

    const t = report.timing;
    const timingParts = [];
    if (t.demucsMs !== null) timingParts.push(`demucs ${formatElapsed(t.demucsMs)}`);
    if (t.whisperMs !== null) timingParts.push(`whisper ${formatElapsed(t.whisperMs)}`);
    if (t.clapMs !== null) timingParts.push(`clap ${formatElapsed(t.clapMs)}`);
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

// ─── Recomendación automática de versión ──────────────────────────────────────

// Puntúa un reporte individual. Mayor puntaje = mejor versión.
// Nunca decide solo — solo recomienda. El usuario siempre confirma.
function scoreReport(report) {
  let score = 100;
  if (report.durationOk === false) score -= 30;
  if (report.abruptCutoff === true) score -= 25;
  if (report.clippingFlag) score -= 15;
  if (report.levenshteinScore !== null && report.levenshteinScore < 0.75) score -= 20;
  if (report.levenshteinScore !== null) score += Math.round(report.levenshteinScore * 10); // bonus por fidelidad
  if (report.titleCantado === true) score -= 10;
  if (report.tagLeaking.length > 0) score -= 15;
  if (report.missingNames.length > 0) score -= 20;
  if (report.demucs.vocalPresence === true) score -= 30; // instrumental accidental
  // CLAP — señal informativa de calidad perceptual (max ±15 pts).
  // Peso deliberadamente bajo hasta validar correlación con oído humano.
  // Si CLAP no corrió (error/no instalado): 0 pts, no penaliza ni bonifica.
  if (report.clap && report.clap.score !== null) {
    if (report.clap.score < 50) score -= 15;        // producción inaceptable
    else if (report.clap.score < 70) score -= 5;     // producción mediocre
    else if (report.clap.score > 85) score += 5;     // producción excelente
  }
  return score;
}

function pickBestVersion(reportA, reportB) {
  if (!reportB) {
    return { recommended: 'A', reason: 'Solo hay una versión disponible.', scoreA: scoreReport(reportA), scoreB: null };
  }

  const scoreA = scoreReport(reportA);
  const scoreB = scoreReport(reportB);

  const reasons = [];

  if (scoreA > scoreB) {
    reasons.push(`Versión A tiene mejor puntaje global (${scoreA} vs ${scoreB})`);
    if (reportA.durationOk && !reportB.durationOk) reasons.push('A tiene duración OK, B no');
    if (reportA.levenshteinScore > (reportB.levenshteinScore || 0)) {
      reasons.push(`A tiene mejor match de letra (${Math.round((reportA.levenshteinScore || 0) * 100)}% vs ${Math.round((reportB.levenshteinScore || 0) * 100)}%)`);
    }
    return { recommended: 'A', reason: reasons.join('. ') + '.', scoreA, scoreB };
  } else if (scoreB > scoreA) {
    reasons.push(`Versión B tiene mejor puntaje global (${scoreB} vs ${scoreA})`);
    if (reportB.durationOk && !reportA.durationOk) reasons.push('B tiene duración OK, A no');
    if ((reportB.levenshteinScore || 0) > (reportA.levenshteinScore || 0)) {
      reasons.push(`B tiene mejor match de letra (${Math.round((reportB.levenshteinScore || 0) * 100)}% vs ${Math.round((reportA.levenshteinScore || 0) * 100)}%)`);
    }
    return { recommended: 'B', reason: reasons.join('. ') + '.', scoreA, scoreB };
  } else {
    return { recommended: 'A', reason: `Empate técnico (${scoreA} puntos cada una). Se recomienda A por defecto.`, scoreA, scoreB };
  }
}

module.exports = {
  analyzeAudio,
  prepareVocals,
  cleanupVocalsTmp,
  transcribeFiles,
  runClapScore,
  printReport,
  pickBestVersion,
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
