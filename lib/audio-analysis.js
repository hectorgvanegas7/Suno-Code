// lib/audio-analysis.js — Análisis de MP3: duración (ffprobe) + calidad de audio
// (corte abrupto, clipping) + transcripción (Whisper via Python) + comparación
// contra song.txt (Levenshtein) + separación de voz opcional (demucs) +
// evaluación perceptual con CLAP (calidad vocal, producción, emoción, artefactos) +
// MOS de voz con NISQA (naturalidad, ruido, discontinuidad, coloración, volumen) +
// palabras/nombres pegados sin pausa (checkNamePacing/detectMergedWordPairs,
// usa los word timestamps que Whisper ya devuelve — sin dependencia nueva).
//
// INFORMA, no decide. Nunca sube nada, nunca elige versión.
// Whisper sobre canto da falsos positivos — siempre aclararlo en la salida.
// CLAP es una señal informativa nueva (±15 pts) — no decide solo.
// NISQA es una señal informativa nueva (±10 pts, más conservador que CLAP
// hasta validarla en vivo) — no decide solo.
// Nombre pegado a palabra vecina (±15 pts, igual peso que nameAudioChecks) —
// umbrales de hueco SIN calibrar contra oído humano todavía, ver
// logs/pacing-feedback.jsonl (verify-audio.js) para ajustarlos con casos reales.
//
// Instalación de dependencias avanzadas (opcionales, degradan con gracia si faltan):
//   npm install fastest-levenshtein
//   pip install faster-whisper
//   pip install torch --index-url https://download.pytorch.org/whl/cu124
//   pip install torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124
//   pip install soundfile
//   pip install demucs      (opcional — solo hace falta para --demucs)
//   pip install transformers librosa   (opcional — solo hace falta para CLAP)
//   pip install torchmetrics   (opcional — solo hace falta para NISQA)

const { spawnSync, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { distance } = require('fastest-levenshtein');
const { extractLyricNameVariants } = require('./text-helpers');

const SONG_PATH = path.join(__dirname, '..', 'song.txt');
const TRANSCRIBE_SCRIPT = path.join(__dirname, 'transcribe.py');
const CLAP_SCRIPT = path.join(__dirname, 'clap_score.py');
const NISQA_SCRIPT = path.join(__dirname, 'nisqa_score.py');
const F0_GENDER_SCRIPT = path.join(__dirname, 'f0_gender_check.py');
const MUQ_EVAL_SCRIPT = path.join(__dirname, 'muq_eval_score.py');
const AUDIOBOX_SCRIPT = path.join(__dirname, 'audiobox_score.py');

// Duración ideal de una canción (segundos)
const MIN_DURATION_S = 2 * 60 + 45; // 2:45
const MAX_DURATION_S = 3 * 60 + 30; // 3:30

// Umbrales de calidad de audio
const CLIP_SAMPLE_THRESHOLD = 50; // muestras clippeadas por debajo de esto = ruido normal
const ABRUPT_CUTOFF_DROP_DB = 6; // un fade-out natural cae más de esto en el último medio segundo
const VOCAL_SILENCE_DB = -50; // mean_volume por debajo de esto = "sin voz" (instrumental accidental)

// Huecos entre palabras consecutivas (word timestamps de Whisper) por debajo
// de esto se consideran "pegadas sin pausa" (ej. "Clara tú" cantado como
// "Claratu" corrido, sin separación real). Valores iniciales SIN calibrar
// contra oído humano — ver logs/pacing-feedback.jsonl (verify-audio.js) para
// ajustarlos con casos reales confirmados en vez de a ojo.
const NAME_GAP_MERGE_THRESHOLD_S = 0.08; // nombres: más laxo, mejor pecar de falso positivo
const GENERAL_GAP_MERGE_THRESHOLD_S = 0.03; // resto de la letra: más estricto, canto rápido normal tiene huecos cortos

// ─── Helpers de proceso ───────────────────────────────────────────────────────

// Python en Windows, cuando su stdin/stdout es un pipe (no una consola real —
// exactamente el caso de spawnSync desde Node), decodifica por default con el
// codepage ANSI del sistema en vez de UTF-8. Node SIEMPRE escribe `input` (y
// decodifica argv) en UTF-8, así que sin esto cualquier tílde/ñ en un título
// o encuesta (ej. "Mil Veces Tú") le llega a Python corrompida ("TÃº") —
// confirmado en vivo el 2026-07-03/04 (CLAP no encontraba el archivo por esto
// exacto). PYTHONUTF8 fuerza el modo UTF-8 completo de Python 3.7+ (argv,
// filesystem, stdio); PYTHONIOENCODING cubre además intérpretes más viejos
// que no soportan ese modo. Nunca pisar variables de entorno existentes.
const PYTHON_UTF8_ENV = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };

// Devuelve la última línea no vacía de un stderr de Python — en un traceback,
// la primera línea es siempre "Traceback (most recent call last):" (inútil
// para diagnosticar de un vistazo); la línea con el tipo y mensaje real de la
// excepción es la ÚLTIMA. Truncada a maxLen para no inundar logs ni
// verify-report.json con un traceback entero.
function lastMeaningfulLine(stderr, maxLen = 300) {
  const lines = stderr.trim().split('\n').filter((l) => l.trim());
  const line = lines.length ? lines[lines.length - 1].trim() : stderr.trim();
  return line.length > maxLen ? `${line.slice(0, maxLen)}…` : line;
}

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf-8', timeout: 30000, maxBuffer: 10 * 1024 * 1024, ...opts }, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// ─── ffprobe / ffmpeg ─────────────────────────────────────────────────────────

// Devuelve la duración en segundos, o null si ffprobe no está disponible/falla.
// Async para poder correr A y B en paralelo (Promise.all).
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

// Loudness EBU R128 (filtro ebur128 de ffmpeg): loudness integrado (LUFS),
// rango de loudness (LU) y true peak (dBFS). Señal nueva, puramente
// INFORMATIVA (0 pts en pickBestVersion) hasta calibrarla contra casos reales
// de Suno — mismo criterio que detectMergedWordPairs con el escaneo general
// de la letra: nunca decide sola sin datos en vivo primero (ver LESSONS.md,
// filosofía del repo desde el 2026-07-04). Devuelve null si ffmpeg no está
// disponible o no se pudo parsear el resumen.
async function checkLoudness(mp3Path) {
  const { error, stderr } = await execFileAsync(
    'ffmpeg',
    ['-hide_banner', '-i', mp3Path, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
    { timeout: 30000 }
  );
  if (error) return null;
  const integratedMatch = stderr.match(/Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+)\s*LUFS/);
  if (!integratedMatch) return null;
  const rangeMatch = stderr.match(/Loudness range:\s*\n\s*LRA:\s*([\d.]+)\s*LU/);
  const truePeakMatch = stderr.match(/True peak:\s*\n\s*Peak:\s*(-?[\d.]+)\s*dBFS/);
  return {
    integratedLUFS: parseFloat(integratedMatch[1]),
    loudnessRangeLU: rangeMatch ? parseFloat(rangeMatch[1]) : null,
    truePeakDBFS: truePeakMatch ? parseFloat(truePeakMatch[1]) : null,
  };
}

// Extrae un clip [start, end] (segundos) de un audio a un archivo nuevo, vía
// ffmpeg. Devuelve true si el archivo se generó, false si ffmpeg no está
// disponible o falló (nunca lanza).
async function extractAudioClip(mp3Path, start, end, outPath) {
  const clipDuration = Math.max(0.3, end - start);
  const { error } = await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', String(Math.max(0, start)), '-t', String(clipDuration),
    '-i', mp3Path, outPath,
  ], { timeout: 15000 });
  return !error && fs.existsSync(outPath);
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
// Verifica que el resultado i-ésimo del batch de Python corresponde al archivo
// pedido — transcribe.py / clap_score.py / nisqa_score.py devuelven `file` con
// el path que recibieron. Sin este chequeo, un reordenamiento u omisión en el
// batch cruzaría los resultados de A y B EN SILENCIO (la recomendación de
// pickBestVersion saldría de la versión equivocada). Devuelve null si coincide
// o no hay dato para comparar; si no, el texto del problema.
function batchFileMismatch(expectedPath, gotFile) {
  if (!expectedPath || !gotFile) return null;
  if (path.resolve(String(expectedPath)) === path.resolve(String(gotFile))) return null;
  return `resultado de otro archivo (esperado "${path.basename(String(expectedPath))}", llegó "${path.basename(String(gotFile))}")`;
}

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
      env: PYTHON_UTF8_ENV,
      timeout: perFileTimeoutMin * 60 * 1000 * paths.length,
      maxBuffer: 10 * 1024 * 1024,
    });
    outcome.whisperMs = Date.now() - whisperStart;

    if (result.stderr && result.stderr.trim()) {
      console.warn(`   ${lastMeaningfulLine(result.stderr)}`);
    }
    if (!result.stdout) {
      const msg = result.stderr
        ? `Whisper stderr: ${lastMeaningfulLine(result.stderr)}`
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
      const mismatch = batchFileMismatch(paths[i], p.file);
      if (mismatch) {
        outcome.results[i].error = `Whisper devolvió ${mismatch}`;
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

// Lanza clap_score.py con los args/stdin ya armados y parsea su salida batch
// a un array de N resultados. Compartido por runClapScore (args por CLI, un
// solo --dims para todo el batch) y runClapScoreJobs (jobs por stdin, --dims
// distinto por archivo, un solo proceso/carga de modelo para todos). Nunca
// lanza — si CLAP no está instalado o falla, el error queda por resultado.
function runClapProcess(pythonArgs, resultCount, { input, itemNoun = 'archivo', expectedFiles = null } = {}) {
  const outcome = {
    results: Array.from({ length: resultCount }, () => ({ clapScore: null, dimensions: null, weights: null, error: null, elapsedMs: null })),
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

    // Timeout: 3 min por archivo (CLAP es más rápido que Whisper, pero la
    // primera corrida descarga el modelo ~300MB)
    const result = spawnSync(pythonCmd, pythonArgs, {
      input,
      encoding: 'utf-8',
      env: PYTHON_UTF8_ENV,
      timeout: 3 * 60 * 1000 * resultCount,
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
        ? `CLAP stderr: ${lastMeaningfulLine(result.stderr)}`
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

    // 1 resultado → objeto único; N → { batch, results: [...] }
    const perFile = parsed.batch ? parsed.results : [parsed];
    for (let i = 0; i < outcome.results.length; i++) {
      const p = perFile[i];
      if (!p) {
        outcome.results[i].error = `CLAP no devolvió resultado para este ${itemNoun}.`;
        continue;
      }
      const mismatch = batchFileMismatch(expectedFiles && expectedFiles[i], p.file);
      if (mismatch) {
        outcome.results[i].error = `CLAP devolvió ${mismatch}`;
        continue;
      }
      outcome.results[i].elapsedMs = p.elapsed_ms ?? null;
      if (p.error) {
        outcome.results[i].error = p.error;
      } else {
        outcome.results[i].clapScore = p.clap_score ?? null;
        outcome.results[i].dimensions = p.dimensions ?? null;
        outcome.results[i].weights = p.weights ?? null;
      }
    }
  } catch (e) {
    if (outcome.clapMs === null) outcome.clapMs = Date.now() - clapStart;
    outcome.results.forEach((r) => { if (!r.error && r.clapScore === null) r.error = e.message; });
  }
  return outcome;
}

// Corre lib/clap_score.py sobre uno o más MP3 y devuelve los scores CLAP.
// Mismo patrón que transcribeFiles(): spawnSync → parse JSON → graceful degrade.
// dims: subconjunto opcional de dimensiones a calcular (ver clap_score.py --dims).
// Devuelve { results: [{clapScore, dimensions, weights, error, elapsedMs}], clapMs }.
function runClapScore(mp3Paths, { device = null, dims = null } = {}) {
  const pythonArgs = [CLAP_SCRIPT, ...mp3Paths];
  if (device) pythonArgs.push('--device', device);
  if (dims && dims.length) pythonArgs.push('--dims', dims.join(','));
  return runClapProcess(pythonArgs, mp3Paths.length, { expectedFiles: mp3Paths });
}

// Corre lib/clap_score.py UNA sola vez (un solo proceso, una sola carga de
// modelo) para N jobs que pueden pedir --dims distinto cada uno — ej. mix
// completo (production/artifacts/ending) y voz aislada (vocal_clarity/emotion)
// de las versiones A y B en una sola invocación en vez de dos. jobs pasa por
// stdin como JSON en vez de args de línea de comandos (ver clap_score.py
// --jobs-stdin). jobs: [{ path, dims }]. Resultados alineados por índice con
// `jobs`, mismo contrato que runClapScore.
function runClapScoreJobs(jobs, { device = null } = {}) {
  const pythonArgs = [CLAP_SCRIPT, '--jobs-stdin'];
  if (device) pythonArgs.push('--device', device);
  const input = JSON.stringify(jobs.map((j) => ({ file: j.path, dims: j.dims })));
  return runClapProcess(pythonArgs, jobs.length, { input, itemNoun: 'job', expectedFiles: jobs.map((j) => j.path) });
}

// Dimensiones que tienen sentido evaluadas sobre la voz aislada (sin la
// música tapando defectos vocales) vs las que evalúan la mezcla completa y por
// eso no aplican a un stem de voz sola.
const CLAP_VOCAL_DIMS = ['vocal_clarity', 'emotion'];
const CLAP_MIX_DIMS = ['production', 'artifacts', 'ending'];

// Combina el resultado de CLAP sobre el mix y sobre la voz aislada de UN mismo
// archivo en un solo { clapScore, dimensions, error, elapsedMs }. El score
// global se recalcula acá con los `weights` que devolvió Python — nunca se
// duplica la tabla de pesos de clap_score.py en JS, así no hay dos fuentes de
// verdad si se ajustan los pesos allá.
function combineClapDimensionResults(mixResult, vocalResult) {
  const dimensions = {};
  const weights = {};
  let elapsedMs = 0;
  const errors = [];

  for (const r of [mixResult, vocalResult]) {
    if (!r) continue;
    elapsedMs += r.elapsedMs || 0;
    if (r.error) { errors.push(r.error); continue; }
    Object.assign(dimensions, r.dimensions || {});
    Object.assign(weights, r.weights || {});
  }

  if (Object.keys(dimensions).length === 0) {
    return { clapScore: null, dimensions: null, error: errors.join(' | ') || 'CLAP sin resultados', elapsedMs };
  }

  let weightedSum = 0;
  let weightTotal = 0;
  for (const [dim, score] of Object.entries(dimensions)) {
    const w = weights[dim] ?? 1;
    weightedSum += score * w;
    weightTotal += w;
  }
  const clapScore = weightTotal > 0 ? Math.round(weightedSum / weightTotal) : null;

  // Con resultado parcial (ej. la voz aislada falló pero el mix no) se sigue
  // devolviendo el score de lo que sí funcionó — el error queda anotado pero
  // no tira todo el resultado, misma filosofía que "CLAP nunca lanza".
  return { clapScore, dimensions, error: errors.length ? errors.join(' | ') : null, elapsedMs };
}

// Para cada índice, la voz aislada si demucs corrió/no falló, si no el mix
// completo. Compartida por runClapScoreWithVocalIsolation y por el llamado a
// NISQA en verify-audio.js — ambos necesitan la misma decisión de "qué
// archivo representa mejor la voz de esta versión" y no debe haber dos
// fuentes divergentes de esa lógica.
function resolveVocalOrMixPaths(mixPaths, vocalPaths) {
  return vocalPaths.map((p, i) => p || mixPaths[i]);
}

// Corre CLAP para 1+ versiones aprovechando separación de voz cuando está
// disponible: vocal_clarity/emotion se miden sobre la voz aislada, production/
// artifacts/ending sobre el mix completo. Sin voz aislada para una versión
// (vocalPaths[i] null — demucs no corrió o falló), esa versión evalúa las 5
// dimensiones sobre el mix, como antes.
// mixPaths y vocalPaths van alineados por índice.
// Devuelve { results: [{clapScore, dimensions, error, elapsedMs}], clapMs }.
function runClapScoreWithVocalIsolation(mixPaths, vocalPaths, { device = null } = {}) {
  const hasAnyVocal = vocalPaths.some((p) => !!p);

  if (!hasAnyVocal) {
    // Sin voz aislada para ninguna versión (demucs no corrió/falló): comportamiento
    // clásico, las 5 dimensiones en una sola corrida sobre el mix.
    const batch = runClapScore(mixPaths, { device });
    return { results: batch.results, clapMs: batch.clapMs };
  }

  // Versiones sin stem propio (vocalPaths[i] null) usan el mix también para
  // vocal_clarity/emotion — mejor una medición sobre el mix que perder la
  // dimensión por completo.
  const vocalPathsFilled = resolveVocalOrMixPaths(mixPaths, vocalPaths);

  // Mix + voz de todas las versiones en UNA sola invocación de clap_score.py
  // (un solo proceso, una sola carga de modelo) en vez de dos — cada job pide
  // su propio --dims vía runClapScoreJobs.
  const jobs = [
    ...mixPaths.map((path) => ({ path, dims: CLAP_MIX_DIMS })),
    ...vocalPathsFilled.map((path) => ({ path, dims: CLAP_VOCAL_DIMS })),
  ];
  const batch = runClapScoreJobs(jobs, { device });
  const n = mixPaths.length;
  const mixResults = batch.results.slice(0, n);
  const vocalResults = batch.results.slice(n);

  const results = mixPaths.map((_, i) => combineClapDimensionResults(
    mixResults[i],
    vocalResults[i],
  ));

  return { results, clapMs: batch.clapMs };
}

// ─── NISQA — MOS de naturalidad de voz ───────────────────────────────────────

// Lanza nisqa_score.py y parsea su salida batch a un array de N resultados.
// Mismo patrón que runClapProcess: nunca lanza — si NISQA no está instalado o
// falla, el error queda por resultado.
function runNisqaProcess(pythonArgs, resultCount, { expectedFiles = null } = {}) {
  const outcome = {
    results: Array.from({ length: resultCount }, () => ({ nisqaScore: null, mos: null, dimensions: null, error: null, elapsedMs: null })),
    nisqaMs: null,
  };

  if (!fs.existsSync(NISQA_SCRIPT)) {
    const msg = `nisqa_score.py no existe en ${NISQA_SCRIPT}`;
    outcome.results.forEach((r) => { r.error = msg; });
    return outcome;
  }

  const nisqaStart = Date.now();
  try {
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

    const result = spawnSync(pythonCmd, pythonArgs, {
      encoding: 'utf-8',
      env: PYTHON_UTF8_ENV,
      timeout: 3 * 60 * 1000 * resultCount,
      maxBuffer: 10 * 1024 * 1024,
    });
    outcome.nisqaMs = Date.now() - nisqaStart;

    if (result.stderr && result.stderr.trim()) {
      const lines = result.stderr.trim().split('\n');
      for (const line of lines.slice(0, 3)) {
        console.log(`   [NISQA] ${line.trim()}`);
      }
    }
    if (!result.stdout) {
      const msg = result.stderr
        ? `NISQA stderr: ${lastMeaningfulLine(result.stderr)}`
        : 'NISQA no produjo salida.';
      outcome.results.forEach((r) => { r.error = msg; });
      return outcome;
    }

    let parsed;
    try {
      parsed = JSON.parse(result.stdout.trim().split('\n').pop());
    } catch {
      outcome.results.forEach((r) => { r.error = 'No se pudo parsear la salida de NISQA.'; });
      return outcome;
    }

    if (parsed.error && !parsed.batch) {
      outcome.results.forEach((r) => { r.error = parsed.error; });
      return outcome;
    }

    const perFile = parsed.batch ? parsed.results : [parsed];
    for (let i = 0; i < outcome.results.length; i++) {
      const p = perFile[i];
      if (!p) {
        outcome.results[i].error = 'NISQA no devolvió resultado para este archivo.';
        continue;
      }
      const mismatch = batchFileMismatch(expectedFiles && expectedFiles[i], p.file);
      if (mismatch) {
        outcome.results[i].error = `NISQA devolvió ${mismatch}`;
        continue;
      }
      outcome.results[i].elapsedMs = p.elapsed_ms ?? null;
      if (p.error) {
        outcome.results[i].error = p.error;
      } else {
        outcome.results[i].nisqaScore = p.nisqa_score ?? null;
        outcome.results[i].mos = p.mos ?? null;
        outcome.results[i].dimensions = p.dimensions ?? null;
      }
    }
  } catch (e) {
    if (outcome.nisqaMs === null) outcome.nisqaMs = Date.now() - nisqaStart;
    outcome.results.forEach((r) => { if (!r.error && r.nisqaScore === null) r.error = e.message; });
  }
  return outcome;
}

// Corre lib/nisqa_score.py sobre uno o más audios (idealmente la voz aislada,
// ver resolveVocalOrMixPaths) y devuelve el MOS normalizado de cada uno.
// Mismo patrón que runClapScore: spawnSync → parse JSON → graceful degrade.
// Devuelve { results: [{nisqaScore, mos, dimensions, error, elapsedMs}], nisqaMs }.
function runNisqaScore(audioPaths, { device = null } = {}) {
  const pythonArgs = [NISQA_SCRIPT, ...audioPaths];
  if (device) pythonArgs.push('--device', device);
  return runNisqaProcess(pythonArgs, audioPaths.length, { expectedFiles: audioPaths });
}

// ─── Calidad musical percibida (MuQ-Eval) + producción (Audiobox) ────────────

// Helper compartido por runMuqEvalScore/runAudioboxScore: mismo contrato que
// runClapProcess/runNisqaProcess (nunca lanza, error por-resultado, salida
// batch de Python parseada de la última línea de stdout, batchFileMismatch
// por índice) parametrizado en vez de duplicado por 3ª y 4ª vez. Los scripts
// nuevos tienen salidas planas (sin dims por job ni recombinación), así que
// un solo helper alcanza.
// `fields`: { claveJs: clavePython } para copiar del resultado por archivo.
function runSimpleScoreProcess(scriptPath, label, fields, audioPaths, { device = null, timeoutPerFileMs = 3 * 60 * 1000 } = {}) {
  const emptyResult = () => {
    const r = { error: null, elapsedMs: null };
    for (const jsKey of Object.keys(fields)) r[jsKey] = null;
    return r;
  };
  const outcome = {
    results: Array.from({ length: audioPaths.length }, emptyResult),
    totalMs: null,
  };

  if (!fs.existsSync(scriptPath)) {
    const msg = `${path.basename(scriptPath)} no existe en ${scriptPath}`;
    outcome.results.forEach((r) => { r.error = msg; });
    return outcome;
  }

  const start = Date.now();
  try {
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const pythonArgs = [scriptPath, ...audioPaths];
    if (device) pythonArgs.push('--device', device);

    const result = spawnSync(pythonCmd, pythonArgs, {
      encoding: 'utf-8',
      env: PYTHON_UTF8_ENV,
      // La primera corrida descarga checkpoints de HF — techo generoso.
      timeout: timeoutPerFileMs * audioPaths.length,
      maxBuffer: 10 * 1024 * 1024,
    });
    outcome.totalMs = Date.now() - start;

    if (result.stderr && result.stderr.trim()) {
      for (const line of result.stderr.trim().split('\n').slice(0, 3)) {
        console.log(`   [${label}] ${line.trim()}`);
      }
    }
    if (!result.stdout) {
      const msg = result.stderr
        ? `${label} stderr: ${lastMeaningfulLine(result.stderr)}`
        : `${label} no produjo salida.`;
      outcome.results.forEach((r) => { r.error = msg; });
      return outcome;
    }

    let parsed;
    try {
      parsed = JSON.parse(result.stdout.trim().split('\n').pop());
    } catch {
      outcome.results.forEach((r) => { r.error = `No se pudo parsear la salida de ${label}.`; });
      return outcome;
    }

    if (parsed.error && !parsed.batch) {
      outcome.results.forEach((r) => { r.error = parsed.error; });
      return outcome;
    }

    const perFile = parsed.batch ? parsed.results : [parsed];
    for (let i = 0; i < outcome.results.length; i++) {
      const p = perFile[i];
      if (!p) {
        outcome.results[i].error = `${label} no devolvió resultado para este archivo.`;
        continue;
      }
      const mismatch = batchFileMismatch(audioPaths[i], p.file);
      if (mismatch) {
        outcome.results[i].error = `${label} devolvió ${mismatch}`;
        continue;
      }
      outcome.results[i].elapsedMs = p.elapsed_ms ?? null;
      if (p.error) {
        outcome.results[i].error = p.error;
      } else {
        for (const [jsKey, pyKey] of Object.entries(fields)) {
          outcome.results[i][jsKey] = p[pyKey] ?? null;
        }
      }
    }
  } catch (e) {
    if (outcome.totalMs === null) outcome.totalMs = Date.now() - start;
    outcome.results.forEach((r) => { if (!r.error) r.error = e.message; });
  }
  return outcome;
}

// Corre lib/muq_eval_score.py (calidad musical percibida, head A1 sobre
// MuQ-310M — ver ese script para instalación y el matiz de SRCC per-clip)
// sobre el MIX completo de 1+ versiones. INFORMATIVO: 0 pts en
// pickBestVersion hasta calibrar en vivo, mismo criterio que loudness/pacing.
// Devuelve { results: [{ score (1-5), scoreStd, nClips, error, elapsedMs }], muqMs }.
function runMuqEvalScore(audioPaths, { device = null } = {}) {
  const outcome = runSimpleScoreProcess(
    MUQ_EVAL_SCRIPT,
    'MuQ-Eval',
    { score: 'score', scoreStd: 'score_std', nClips: 'n_clips' },
    audioPaths,
    { device },
  );
  return { results: outcome.results, muqMs: outcome.totalMs };
}

// Corre lib/audiobox_score.py (Meta Audiobox Aesthetics: PQ/PC/CE/CU ~1-10)
// sobre el MIX completo de 1+ versiones. PQ (Production Quality) es el
// titular; los otros 3 ejes viajan igual para calibración. INFORMATIVO:
// 0 pts en pickBestVersion hasta calibrar en vivo.
// Devuelve { results: [{ pq, pc, ce, cu, error, elapsedMs }], audioboxMs }.
function runAudioboxScore(audioPaths, { device = null } = {}) {
  const outcome = runSimpleScoreProcess(
    AUDIOBOX_SCRIPT,
    'Audiobox',
    { pq: 'pq', pc: 'pc', ce: 'ce', cu: 'cu' },
    audioPaths,
    { device },
  );
  return { results: outcome.results, audioboxMs: outcome.totalMs };
}

// ─── F0 — género de voz por frecuencia fundamental ───────────────────────────

// Corrige un error sistemático confirmado en vivo (2026-07-10, "Mi
// promesa"): pyin sobre la voz YA AISLADA por demucs a veces bloquea un
// armónico en vez del fundamental real, devolviendo un F0 muy por encima del
// real — reportó con confianza "Femenina" (235.7/263 Hz) para una voz que
// Hector confirmó de oído que era masculina. Corriendo el mismo script sobre
// el MIX completo (sin aislar) dio 116.5/117.2 Hz — Masculina.
//
// El primer fix (2026-07-10, versión inicial) solo marcaba conflicto si el
// ratio caía cerca de un 2x exacto (una octava limpia). Se probó en vivo esa
// misma noche con "Sábado Veinte de Septiembre" y se escapó un caso real:
// voz aislada 263 Hz vs. mix 94.3 Hz — ratio 2.79x, fuera de la ventana
// 1.7-2.35x porque el mix también viene sesgado (lo tira hacia abajo el bajo/
// instrumentos, auditoría 2026-07-09), así que el desfase entre las dos
// mediciones no es una octava limpia. **Fix ampliado:** en vez de exigir un
// ratio específico, alcanza con que las dos mediciones INDEPENDIENTES
// discrepen en la clasificación categórica (Masculina vs. Femenina) — eso ya
// es evidencia suficiente de que no hay que afirmar un género con confianza,
// sin importar cuál sea exactamente la relación numérica entre ambas.
function reconcileF0Octave(vocalResult, mixResult) {
  const result = { ...vocalResult };
  if (
    vocalResult && mixResult &&
    vocalResult.medianF0Hz != null && mixResult.medianF0Hz != null &&
    !vocalResult.error && !mixResult.error
  ) {
    result.mixCheckF0Hz = mixResult.medianF0Hz;
    const bothClassified = vocalResult.detectedGender && vocalResult.detectedGender !== 'Indeterminado'
      && mixResult.detectedGender && mixResult.detectedGender !== 'Indeterminado';
    if (bothClassified && vocalResult.detectedGender !== mixResult.detectedGender) {
      result.octaveConflict = true;
      result.detectedGender = 'Indeterminado';
    }
  }
  return result;
}

// Corre lib/f0_gender_check.py (librosa.pyin, CPU, sin modelo pre-entrenado)
// y devuelve el F0 mediano + género detectado por archivo. Mismo patrón de
// graceful degrade que CLAP/NISQA: si el script falla o no está instalado,
// el error queda por resultado en vez de lanzar. INFORMATIVO — no calibrado
// en vivo todavía, no se usa en pickBestVersion (ver f0_gender_check.py).
function runF0GenderCheck(audioPaths) {
  const outcome = {
    results: Array.from({ length: audioPaths.length }, () => ({ medianF0Hz: null, voicedRatio: null, detectedGender: null, error: null })),
    f0Ms: null,
  };

  if (!fs.existsSync(F0_GENDER_SCRIPT)) {
    const msg = `f0_gender_check.py no existe en ${F0_GENDER_SCRIPT}`;
    outcome.results.forEach((r) => { r.error = msg; });
    return outcome;
  }

  const start = Date.now();
  try {
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    const result = spawnSync(pythonCmd, [F0_GENDER_SCRIPT, ...audioPaths], {
      encoding: 'utf-8',
      env: PYTHON_UTF8_ENV,
      timeout: 60 * 1000 * audioPaths.length,
      maxBuffer: 10 * 1024 * 1024,
    });
    outcome.f0Ms = Date.now() - start;

    if (!result.stdout) {
      const msg = result.stderr ? `F0 stderr: ${lastMeaningfulLine(result.stderr)}` : 'f0_gender_check.py no produjo salida.';
      outcome.results.forEach((r) => { r.error = msg; });
      return outcome;
    }

    let parsed;
    try {
      parsed = JSON.parse(result.stdout.trim().split('\n').pop());
    } catch {
      outcome.results.forEach((r) => { r.error = 'No se pudo parsear la salida de f0_gender_check.py.'; });
      return outcome;
    }

    if (parsed.error && !parsed.batch) {
      outcome.results.forEach((r) => { r.error = parsed.error; });
      return outcome;
    }

    const perFile = parsed.batch ? parsed.results : [parsed];
    for (let i = 0; i < outcome.results.length; i++) {
      const p = perFile[i];
      if (!p) {
        outcome.results[i].error = 'f0_gender_check.py no devolvió resultado para este archivo.';
        continue;
      }
      const mismatch = batchFileMismatch(audioPaths[i], p.file);
      if (mismatch) {
        outcome.results[i].error = `f0_gender_check.py devolvió ${mismatch}`;
        continue;
      }
      if (p.error) {
        outcome.results[i].error = p.error;
      } else {
        outcome.results[i].medianF0Hz = p.median_f0_hz ?? null;
        outcome.results[i].voicedRatio = p.voiced_ratio ?? null;
        outcome.results[i].detectedGender = p.detected_gender ?? null;
      }
    }
  } catch (e) {
    if (outcome.f0Ms === null) outcome.f0Ms = Date.now() - start;
    outcome.results.forEach((r) => { if (!r.error) r.error = e.message; });
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

// Aplana segments[].words en un solo array ordenado cronológicamente (los
// segments ya vienen en orden temporal, así que concatenar alcanza). Fuente
// única de verdad para cualquier función que necesite recorrer las palabras
// de la transcripción en orden — findBestWordMatch, checkNamePacing,
// detectMergedWordPairs.
function flattenWords(segments = []) {
  const allWords = [];
  for (const seg of segments) {
    if (seg.words) allWords.push(...seg.words);
  }
  return allWords;
}

// Busca la palabra (con timestamps) que mejor matchea `name` entre las
// palabras con timestamp de Whisper. Devuelve { word, score } o null si no
// hay palabras o ninguna se acerca. Fuente única de verdad para
// isNameInTranscription (decide presencia/ausencia) y verifyNamePronunciation
// (decide qué ventana de tiempo recortar para la segunda opinión sin pista).
function findBestWordMatch(name, segments = []) {
  const normName = normalizeForCompare(name);
  if (!normName) return null;

  const allWords = flattenWords(segments);

  let bestMatch = null;
  let bestScore = 0;
  for (const w of allWords) {
    const normW = normalizeForCompare(w.word);
    if (!normW || normW.length < 2) continue;

    let score = levenshteinSimilarity(normName, normW);
    // Substring SOLO en la dirección segura: la palabra transcripta contiene
    // el nombre completo (ej. tokenización rara: "scarletmi"). La inversa
    // (nombre contiene la palabra) daría falsos positivos con palabras
    // cortas ("el" dentro de "elena") y con nombres >= 3 chars no hace falta.
    if (normName.length >= 3 && normW.includes(normName)) score = 1.0;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = w;
    }
  }
  return bestMatch ? { word: bestMatch, score: bestScore } : null;
}

// Verifica si un nombre de destinatario está presente en la transcripción
// de forma exacta o difusa (coincidencia de Levenshtein > 0.8 en alguna palabra).
// Con word timestamps de Whisper disponibles, además exige que la palabra que
// matchea tenga probability >= 0.65 — un nombre "encontrado" pero balbuceado
// (probabilidad baja) cuenta como ausente, para que se vea reflejado en
// missingNames y el reporte lo marque para revisión manual.
function isNameInTranscription(name, transcribedText, segments = []) {
  const normName = normalizeForCompare(name);
  if (!normName) return false;

  const hasWordTimestamps = segments.some((seg) => seg.words && seg.words.length > 0);
  if (hasWordTimestamps) {
    const match = findBestWordMatch(name, segments);
    if (match && match.score > 0.8) {
      return match.word.probability >= 0.65;
    }
    return false;
  }

  const normTrans = normalizeForCompare(transcribedText);
  if (!normTrans) return false;
  if (normTrans.includes(normName)) return true;

  const words = normTrans.split(/\s+/);
  for (const w of words) {
    if (w.length > 1 && levenshteinSimilarity(normName, w) > 0.8) {
      return true;
    }
  }
  return false;
}

// Nombres de destinatario que NO aparecen en la transcripción, ni como
// ortografía cruda de encuesta ni como la variante fonética real que quedó
// en `lyricsText` (dict o LLM). Extraída como función pura testeable sin
// audio real — el bug de 2026-07-08 (falsos "ausente" reintroducidos por la
// migración a Windows) fue exactamente en este cruce: `lyricsText` tiene que
// ser la letra YA con el reemplazo fonético aplicado (ver `applyPhoneticReplacements`
// en `verify-audio.js`/`suno-fill.js`), no la cruda de `song.txt`.
function computeMissingNames(firstNames, lyricsText, transcribedText, segments = []) {
  if (!firstNames || firstNames.length === 0) return [];
  const lyricVariants = extractLyricNameVariants(lyricsText, firstNames);
  return firstNames.filter((name) => {
    if (isNameInTranscription(name, transcribedText, segments)) return false;
    const variant = lyricVariants[name];
    if (variant && variant !== name && isNameInTranscription(variant, transcribedText, segments)) return false;
    return true;
  });
}

// ─── Re-chequeo de pronunciación: transcripción SIN pista de la letra ────────
//
// isNameInTranscription (arriba) confía en la transcripción de Whisper, pero
// esa transcripción corre con initial_prompt=letra completa (en modo
// --demucs) para reducir alucinaciones sobre canto — efecto secundario
// documentado: sesga a Whisper a "escuchar" la palabra que ya sabe que está
// buscando, incluso si el audio real tiene un sonido inicial espurio (ver
// LESSONS.md, incidente real de un nombre vocal-inicial sonando con una "H"/
// "J" fantasma en Suno pero pasando la verificación igual). Esta función
// re-transcribe SOLO la ventana de tiempo donde matcheó el nombre, sin
// ninguna pista, como segunda opinión independiente de ese sesgo.
// INFORMATIVO — nunca cambia missingNames; agrega una alerta aparte y deja un
// clip de audio de ~1-2s a mano para confirmar de oído en segundos en vez de
// escuchar la canción entera. Devuelve null si no hay timestamp confiable de
// dónde recortar (ej. sin word timestamps) o si el recorte/re-transcripción
// falla — nunca lanza, nunca bloquea el análisis principal.
async function verifyNamePronunciation(targetPath, name, segments, { clipDir, model = 'small', device = null } = {}) {
  const match = findBestWordMatch(name, segments);
  if (!match || match.score <= 0.8) return null;

  const { word } = match;
  const start = Math.max(0, word.start - 0.25);
  const end = word.end + 0.25;

  try {
    fs.mkdirSync(clipDir, { recursive: true });
  } catch {
    return null; // no se pudo preparar la carpeta de clips — no bloquea el análisis
  }
  const safeName = name.replace(/[^a-z0-9áéíóúñ]/gi, '_');
  const clipPath = path.join(clipDir, `${path.basename(targetPath, path.extname(targetPath))}-${safeName}.wav`);

  const extracted = await extractAudioClip(targetPath, start, end, clipPath);
  if (!extracted) return null;

  const unprimed = transcribeFiles([clipPath], { model, device, initialPrompt: null });
  const r = unprimed.results[0];
  if (r.error || !r.parsed) {
    return { clipPath, confirmed: null, unprimedText: null, error: r.error };
  }

  const unprimedText = r.parsed.text || '';
  const normName = normalizeForCompare(name);
  const normUnprimed = normalizeForCompare(unprimedText);
  // Umbral más laxo que el chequeo principal (0.6 vs 0.8): el clip es
  // brevísimo y aislado de su contexto melódico, así que la transcripción
  // natural es más ruidosa incluso para una pronunciación correcta — el
  // objetivo acá es solo detectar una discrepancia CLARA, no exigir precisión.
  const confirmed = !!normUnprimed && (normUnprimed.includes(normName) || levenshteinSimilarity(normName, normUnprimed) > 0.6);
  return { clipPath, confirmed, unprimedText };
}

// ─── Palabras/nombres pegados sin pausa ──────────────────────────────────────
//
// Suno a veces canta dos palabras corridas, sin la pausa natural entre ellas
// (ej. "Clara tú" sonando como "Claratu"). Los word timestamps que Whisper ya
// devuelve (word_timestamps=True en transcribe.py) alcanzan para detectar
// esto: si el hueco entre el fin de una palabra y el inicio de la siguiente
// es casi cero, están pegadas. No hace falta ningún modelo/dependencia nueva.

// Mide el hueco (en segundos) antes y después de la palabra que matchea
// `name` en la transcripción. Devuelve
// { mergedBefore, mergedAfter, gapBeforeS, gapAfterS, prevWord, nextWord }
// o null si no hay match confiable o no hay timestamps. Nunca lanza.
function checkNamePacing(name, segments = [], threshold = NAME_GAP_MERGE_THRESHOLD_S) {
  const match = findBestWordMatch(name, segments);
  if (!match || match.score <= 0.8) return null;

  const allWords = flattenWords(segments);
  const idx = allWords.indexOf(match.word);
  if (idx === -1) return null;

  const prevWord = idx > 0 ? allWords[idx - 1] : null;
  const nextWord = idx < allWords.length - 1 ? allWords[idx + 1] : null;

  const gapBeforeS = prevWord ? match.word.start - prevWord.end : null;
  const gapAfterS = nextWord ? nextWord.start - match.word.end : null;

  const mergedBefore = gapBeforeS !== null && gapBeforeS < threshold;
  const mergedAfter = gapAfterS !== null && gapAfterS < threshold;

  if (!mergedBefore && !mergedAfter) return null;

  return { mergedBefore, mergedAfter, gapBeforeS, gapAfterS, prevWord, nextWord, word: match.word };
}

// Escanea TODOS los pares de palabras consecutivas de la transcripción y
// devuelve los que tienen un hueco por debajo del umbral general — señal
// puramente informativa (no decide, no afecta el puntaje) para que Hector
// pueda revisar de oído si Suno está corriendo palabras en general, no solo
// en los nombres. Devuelve [{ wordA, wordB, gapS, timestamp }].
function detectMergedWordPairs(segments = [], threshold = GENERAL_GAP_MERGE_THRESHOLD_S) {
  const allWords = flattenWords(segments);
  const pairs = [];
  for (let i = 0; i < allWords.length - 1; i++) {
    const a = allWords[i];
    const b = allWords[i + 1];
    const gapS = b.start - a.end;
    if (gapS < threshold) {
      pairs.push({ wordA: a.word, wordB: b.word, gapS, timestamp: a.start });
    }
  }
  return pairs;
}

// ─── Palabras cortadas a la mitad ────────────────────────────────────────────
//
// Distinto de "nombre ausente" (computeMissingNames — la palabra no se canta
// para nada) y de "pegadas" (detectMergedWordPairs — dos palabras SIN hueco
// entre sí): acá la palabra SÍ se canta, pero Suno la corta antes de
// terminarla (ej. "Fran-" en vez de "Frank"). Pedido real de Hector
// (2026-07-09). Combina 3 señales baratas, cero dependencia nueva:
//   1. Duración real de la palabra (Whisper) mucho menor a la esperada según
//      su cantidad de vocales (proxy barato de sílabas — no es un G2P real).
//   2. Probability baja de Whisper para esa palabra — Whisper "duda" de lo
//      que transcribió, coincide con una pronunciación real incompleta.
//   3. Caída de volumen entre la primera y la segunda mitad de la ventana de
//      la palabra — misma técnica que detectAbruptCutoff (comparar cuerpo vs
//      cola), aplicada a UNA palabra en vez de a toda la canción.
// (1)+(2) gatean qué palabras vale la pena medir con ffmpeg — evita una
// llamada por cada palabra de la canción. (3) es informativa (puede no
// medirse en clips muy cortos) y nunca excluye una candidata ya confirmada
// por (1)+(2).
// PURAMENTE INFORMATIVO (0 pts en pickBestVersion) hasta calibrar en vivo,
// mismo criterio que detectMergedWordPairs. Guarda un clip de ~0.5-1s por
// candidata en `truncated-words/` para confirmar de oído.
const MIN_DURATION_PER_VOWEL_S = 0.09;
const TRUNCATION_PROBABILITY_THRESHOLD = 0.55;
const TRUNCATION_TAIL_DROP_DB = 8;
// Techo de candidatas a medir con ffmpeg por canción — cap explícito y
// LOGUEADO (nunca silencioso) para que "0 detectadas" no se confunda con
// "no se midió nada".
const MAX_TRUNCATION_CANDIDATES = 15;

function countVowelsEs(word) {
  const m = String(word || '').match(/[aeiouáéíóúü]/gi);
  return m ? m.length : 1; // mínimo 1 para no dividir por cero en palabras de 1 sílaba corta
}

// Rediseño auditoría 2026-07-09. La versión anterior exigía duración-corta Y
// probability-baja para siquiera medir — y eso la hacía ciega al caso que
// motivó la señal: "Fran-" en vez de "Frank" CONSERVA su única vocal, que
// cantada dura 200-500ms, muy por encima del umbral de 90ms (el truncamiento
// corta la consonante/sílaba final, no la vocal, así que la duración casi no
// cambia). Ahora:
//   - Gate primario: probability baja de Whisper. OJO: en modo --demucs la
//     transcripción corre con initial_prompt=letra completa, que INFLA la
//     confianza en las palabras esperadas (sesgo documentado en LESSONS.md,
//     2026-07-04) — por eso las candidatas son pocas y medirlas es barato.
//   - Confirmación: duración-corta (tooShort, se mantiene como señal) O caída
//     de volumen entre la primera y la segunda mitad de la palabra (ffmpeg,
//     misma técnica que detectAbruptCutoff). Cualquiera de las dos incluye la
//     palabra en el reporte, con ambos booleanos visibles para calibrar.
// Sigue siendo PURAMENTE INFORMATIVO (0 pts en pickBestVersion) hasta
// calibrar en vivo con los clips de truncated-words/.
async function detectTruncatedWords(mp3Path, segments, { clipDir = null } = {}) {
  const allWords = flattenWords(segments);
  let candidates = [];

  for (const w of allWords) {
    const actualDurationS = w.end - w.start;
    if (actualDurationS <= 0) continue;
    const normWord = normalizeForCompare(w.word);
    if (!normWord || normWord.length < 2) continue; // muletillas de 1 letra no aplican

    const expectedMinDurationS = countVowelsEs(w.word) * MIN_DURATION_PER_VOWEL_S;
    const tooShort = actualDurationS < expectedMinDurationS;
    const lowProbability = (w.probability ?? 1) < TRUNCATION_PROBABILITY_THRESHOLD;

    if (lowProbability) {
      candidates.push({
        word: w.word,
        start: w.start,
        end: w.end,
        probability: w.probability ?? null,
        expectedMinDurationS: Math.round(expectedMinDurationS * 100) / 100,
        actualDurationS: Math.round(actualDurationS * 100) / 100,
        tooShort,
      });
    }
  }

  if (candidates.length === 0) return [];

  if (candidates.length > MAX_TRUNCATION_CANDIDATES) {
    // Priorizar las de menor probability (las más sospechosas) — y decirlo.
    candidates.sort((a, b) => (a.probability ?? 1) - (b.probability ?? 1));
    console.log(`   (truncated-words: ${candidates.length} candidatas con probability baja — se miden solo las ${MAX_TRUNCATION_CANDIDATES} más sospechosas)`);
    candidates = candidates.slice(0, MAX_TRUNCATION_CANDIDATES);
  }

  const results = [];
  for (const c of candidates) {
    const wordDuration = c.end - c.start;
    const half = wordDuration / 2;
    let volumeDropDb = null;
    if (half > 0) {
      const [firstHalfVol, secondHalfVol] = await Promise.all([
        getMeanVolumeDb(mp3Path, { start: c.start, duration: half }),
        getMeanVolumeDb(mp3Path, { start: c.start + half, duration: half }),
      ]);
      if (firstHalfVol !== null && secondHalfVol !== null) {
        volumeDropDb = Math.round((firstHalfVol - secondHalfVol) * 10) / 10;
      }
    }

    const volumeDropConfirmed = volumeDropDb !== null && volumeDropDb > TRUNCATION_TAIL_DROP_DB;
    // Sin ninguna confirmación (ni duración corta ni caída de volumen), la
    // probability baja sola no alcanza — Whisper duda de muchas palabras
    // cantadas perfectamente normales.
    if (!c.tooShort && !volumeDropConfirmed) continue;

    let clipPath = null;
    if (clipDir) {
      try {
        fs.mkdirSync(clipDir, { recursive: true });
        const safeName = c.word.replace(/[^a-z0-9áéíóúñ]/gi, '_');
        const candidateClipPath = path.join(
          clipDir,
          `${path.basename(mp3Path, path.extname(mp3Path))}-${safeName}-${Math.round(c.start * 10)}.wav`
        );
        const extracted = await extractAudioClip(mp3Path, Math.max(0, c.start - 0.2), c.end + 0.2, candidateClipPath);
        if (extracted) clipPath = candidateClipPath;
      } catch {
        // best-effort — el clip es solo para confirmar de oído, no bloquea el análisis
      }
    }

    results.push({
      ...c,
      volumeDropDb,
      volumeDropConfirmed,
      clipPath,
    });
  }
  return results;
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
async function analyzeAudio(mp3Path, { label = 'Versión', titulo = '', lyricsText = '', useDemucs = false, duration = undefined, firstNames = [], prepared = null, transcriptionOutcome = null, clapOutcome = null, nisqaOutcome = null, expectedGender = null, f0Outcome = null, muqOutcome = null, audioboxOutcome = null } = {}) {
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
    nameAudioChecks: [],
    namePacingIssues: [],
    pacingIssues: [],
    truncatedWords: [],
    clap: { score: null, dimensions: null, error: null },
    nisqa: { score: null, mos: null, dimensions: null, error: null },
    muqEval: { score: null, scoreStd: null, nClips: null, error: null },
    audiobox: { pq: null, pc: null, ce: null, cu: null, error: null },
    f0Gender: { medianF0Hz: null, voicedRatio: null, detectedGender: null, expectedGender: expectedGender || null, mismatch: null, mixCheckF0Hz: null, octaveConflict: false, error: null },
    demucs: { used: false, vocalPresence: null, error: null },
    timing: { demucsMs: null, whisperMs: null, clapMs: null, nisqaMs: null, muqMs: null, audioboxMs: null, f0Ms: null, totalMs: null },
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

  const [abruptCutoff, clippingCount, loudness] = await Promise.all([
    detectAbruptCutoff(mp3Path, report.duration),
    detectClipping(mp3Path),
    checkLoudness(mp3Path),
  ]);
  report.abruptCutoff = abruptCutoff;
  report.clippingCount = clippingCount;
  report.clippingFlag = clippingCount !== null && clippingCount > CLIP_SAMPLE_THRESHOLD;
  report.loudness = loudness; // informativo, 0 pts — ver checkLoudness

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
      report.pacingIssues = detectMergedWordPairs(segments);
      report.truncatedWords = await detectTruncatedWords(mp3Path, segments, {
        clipDir: path.join(path.dirname(mp3Path), 'truncated-words'),
      });
    }
    if (transcribedText) {
      report.tagLeaking = detectTagLeaking(transcribedText, tagLeakKeywords(tags));
      if (firstNames && firstNames.length > 0) {
        const segments = report.transcription?.segments || [];
        // Aceptar tanto el nombre crudo de la encuesta como su variante
        // fonética real en la letra (si el prompt reescribió el nombre para
        // que Suno lo cante bien) — evita falsos "ausente" (ver LESSONS.md).
        const lyricVariants = extractLyricNameVariants(lyricsText, firstNames);
        report.missingNames = computeMissingNames(firstNames, lyricsText, transcribedText, segments);

        // Re-chequeo de pronunciación (segunda opinión sin la pista de la
        // letra) para los nombres que SÍ se dieron por presentes — ver
        // verifyNamePronunciation. Informativo: no cambia missingNames, solo
        // agrega una alerta + un clip de audio corto para confirmar de oído.
        const clipDir = path.join(path.dirname(mp3Path), 'name-check');
        for (const name of firstNames) {
          if (report.missingNames.includes(name)) continue; // ya se marca ausente, nada que reconfirmar
          const variant = lyricVariants[name];
          const candidates = variant && variant !== name ? [name, variant] : [name];
          let check = null;
          let spelledAs = name;
          for (const candidate of candidates) {
            check = await verifyNamePronunciation(prep.targetPath, candidate, segments, {
              clipDir,
              model: useDemucs ? 'large-v3' : 'small',
              device: useDemucs ? 'cuda' : null,
            });
            if (check) { spelledAs = candidate; break; }
          }
          if (check) report.nameAudioChecks.push({ name, spelledAs, ...check });

          // Nombre pegado a la palabra anterior/siguiente sin pausa (ver
          // checkNamePacing) — señal determinística por aritmética de
          // timestamps, independiente del re-chequeo de pronunciación de
          // arriba. Genera un clip de contexto (palabra previa + nombre +
          // palabra siguiente) con el mismo mecanismo que verifyNamePronunciation.
          const pacing = checkNamePacing(spelledAs, segments);
          if (pacing) {
            const clipStart = Math.max(0, (pacing.prevWord || pacing.word).start - 0.2);
            const clipEnd = (pacing.nextWord || pacing.word).end + 0.2;
            const safeName = name.replace(/[^a-z0-9áéíóúñ]/gi, '_');
            const clipPath = path.join(clipDir, `${path.basename(prep.targetPath, path.extname(prep.targetPath))}-${safeName}-pacing.wav`);
            let extracted = false;
            try {
              fs.mkdirSync(clipDir, { recursive: true });
              extracted = await extractAudioClip(prep.targetPath, clipStart, clipEnd, clipPath);
            } catch {
              extracted = false;
            }
            report.namePacingIssues.push({ name, spelledAs, ...pacing, clipPath: extracted ? clipPath : null });
          }
        }
      }
    }

    // 5b. CLAP — evaluación perceptual de calidad de audio. Tiene que correr
    // ACÁ ADENTRO (antes del finally) porque si useDemucs separó la voz,
    // prep.targetPath apunta a un .wav en prep.tmpDir — cleanupVocalsTmp lo
    // borra en el finally, así que leerlo después ya sería tarde.
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
      // Correr CLAP inline (camino de 1 sola versión), aprovechando la voz
      // aislada de `prep` si demucs corrió — mismo criterio que el camino
      // batcheado: vocal_clarity/emotion sobre la voz, el resto sobre el mix.
      const vocalPath = prep.demucs.used ? prep.targetPath : null;
      const clapResult = runClapScoreWithVocalIsolation(
        [mp3Path],
        [vocalPath],
        { device: useDemucs ? 'cuda' : null },
      );
      const cr = clapResult.results[0];
      if (cr.error) {
        report.clap.error = cr.error;
      } else {
        report.clap.score = cr.clapScore ?? null;
        report.clap.dimensions = cr.dimensions ?? null;
      }
      report.timing.clapMs = cr.elapsedMs ?? clapResult.clapMs ?? null;
    }

    // 5c. NISQA — MOS de naturalidad de voz. Mismo motivo que CLAP para correr
    // ACÁ ADENTRO: si useDemucs separó la voz, prep.targetPath apunta a un
    // .wav que cleanupVocalsTmp borra en el finally.
    if (nisqaOutcome) {
      // Resultado pre-computado (camino batcheado de verify-audio.js)
      if (nisqaOutcome.error) {
        report.nisqa.error = nisqaOutcome.error;
      } else {
        report.nisqa.score = nisqaOutcome.nisqaScore ?? null;
        report.nisqa.mos = nisqaOutcome.mos ?? null;
        report.nisqa.dimensions = nisqaOutcome.dimensions ?? null;
      }
      report.timing.nisqaMs = nisqaOutcome.elapsedMs ?? null;
    } else {
      // Correr NISQA inline (camino de 1 sola versión), sobre la voz aislada
      // de `prep` si demucs corrió, si no sobre el mix completo.
      const nisqaPath = prep.demucs.used ? prep.targetPath : mp3Path;
      const nisqaResult = runNisqaScore([nisqaPath], { device: useDemucs ? 'cuda' : null });
      const nr = nisqaResult.results[0];
      if (nr.error) {
        report.nisqa.error = nr.error;
      } else {
        report.nisqa.score = nr.nisqaScore ?? null;
        report.nisqa.mos = nr.mos ?? null;
        report.nisqa.dimensions = nr.dimensions ?? null;
      }
      report.timing.nisqaMs = nr.elapsedMs ?? nisqaResult.nisqaMs ?? null;
    }

    // 5d. F0 — género de voz por frecuencia fundamental. Mismo motivo que
    // CLAP/NISQA para correr ACÁ ADENTRO (voz aislada de demucs, si corrió).
    // INFORMATIVO, no calibrado en vivo — ver lib/f0_gender_check.py.
    if (f0Outcome) {
      if (f0Outcome.error) {
        report.f0Gender.error = f0Outcome.error;
      } else {
        report.f0Gender.medianF0Hz = f0Outcome.medianF0Hz ?? null;
        report.f0Gender.voicedRatio = f0Outcome.voicedRatio ?? null;
        report.f0Gender.detectedGender = f0Outcome.detectedGender ?? null;
        report.f0Gender.mixCheckF0Hz = f0Outcome.mixCheckF0Hz ?? null;
        report.f0Gender.octaveConflict = f0Outcome.octaveConflict ?? false;
      }
      report.timing.f0Ms = f0Outcome.elapsedMs ?? null;
    } else if (prep.demucs.used) {
      const f0Result = runF0GenderCheck([prep.targetPath, mp3Path]);
      const fr = reconcileF0Octave(f0Result.results[0], f0Result.results[1]);
      if (fr.error) {
        report.f0Gender.error = fr.error;
      } else {
        report.f0Gender.medianF0Hz = fr.medianF0Hz ?? null;
        report.f0Gender.voicedRatio = fr.voicedRatio ?? null;
        report.f0Gender.detectedGender = fr.detectedGender ?? null;
        report.f0Gender.mixCheckF0Hz = fr.mixCheckF0Hz ?? null;
        report.f0Gender.octaveConflict = fr.octaveConflict ?? false;
      }
      report.timing.f0Ms = f0Result.f0Ms ?? null;
    } else {
      // Sin voz aislada por demucs, pyin corre sobre la MEZCLA completa y la
      // mediana de F0 la dominan bajo/instrumentos — un "género detectado"
      // sobre el mix es ruido con apariencia de dato (auditoría 2026-07-09).
      // Mejor no correr y decirlo, que reportar basura confiable.
      report.f0Gender.error = 'sin voz aislada (demucs) — F0 sobre el mix completo no es confiable, no se corre';
    }
    if (expectedGender && report.f0Gender.detectedGender && report.f0Gender.detectedGender !== 'Indeterminado') {
      report.f0Gender.mismatch = report.f0Gender.detectedGender !== expectedGender;
    }

    // 5e. MuQ-Eval + Audiobox — calidad musical percibida / de producción.
    // Solo resultados pre-computados (camino batcheado de verify-audio.js,
    // que corre ambos sobre el MIX completo): a diferencia de CLAP/NISQA no
    // hay camino inline — señales nuevas, informativas, sin calibrar; si el
    // caller no las corrió, quedan en null y el reporte simplemente no las
    // muestra.
    if (muqOutcome) {
      if (muqOutcome.error) {
        report.muqEval.error = muqOutcome.error;
      } else {
        report.muqEval.score = muqOutcome.score ?? null;
        report.muqEval.scoreStd = muqOutcome.scoreStd ?? null;
        report.muqEval.nClips = muqOutcome.nClips ?? null;
      }
      report.timing.muqMs = muqOutcome.elapsedMs ?? null;
    }
    if (audioboxOutcome) {
      if (audioboxOutcome.error) {
        report.audiobox.error = audioboxOutcome.error;
      } else {
        report.audiobox.pq = audioboxOutcome.pq ?? null;
        report.audiobox.pc = audioboxOutcome.pc ?? null;
        report.audiobox.ce = audioboxOutcome.ce ?? null;
        report.audiobox.cu = audioboxOutcome.cu ?? null;
      }
      report.timing.audioboxMs = audioboxOutcome.elapsedMs ?? null;
    }
  } finally {
    cleanupVocalsTmp(ownedPrep); // el tmp de un `prepared` externo lo limpia el caller
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

  if (report.loudness) {
    // Puramente informativo (sin calibrar en vivo todavía) — referencia:
    // streaming (Spotify/YouTube) normaliza cerca de -14 LUFS; el broadcast
    // EBU R128 clásico apunta a -23 LUFS. Fuera de [-28, -8] es candidato a
    // sonar perceptiblemente muy bajo o muy comprimido/fuerte.
    const { integratedLUFS, truePeakDBFS } = report.loudness;
    let loudnessNote = `loudness: ${integratedLUFS.toFixed(1)} LUFS`;
    if (integratedLUFS < -28 || integratedLUFS > -8) loudnessNote += ' ⚠️ (fuera de rango típico, revisar de oído)';
    if (truePeakDBFS !== null) loudnessNote += `, true peak ${truePeakDBFS.toFixed(1)} dBFS`;
    flags.push(loudnessNote);
  }

  if (report.f0Gender?.detectedGender) {
    let genderNote = `F0: ${report.f0Gender.medianF0Hz ?? '?'} Hz → voz ${report.f0Gender.detectedGender}`;
    if (report.f0Gender.octaveConflict) {
      genderNote += ` (aislada ${report.f0Gender.medianF0Hz} Hz vs. mix ${report.f0Gender.mixCheckF0Hz} Hz — posible error de octava, no confiar)`;
    } else if (report.f0Gender.mismatch === true) {
      genderNote += ` ⚠️ (encuesta pide ${report.f0Gender.expectedGender}, revisar de oído)`;
    }
    flags.push(genderNote);
  } else if (report.f0Gender?.error) {
    flags.push(`F0 género: no disponible (${report.f0Gender.error.substring(0, 60)})`);
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

  const unconfirmedNames = report.nameAudioChecks.filter((c) => c.confirmed === false);
  if (unconfirmedNames.length > 0) {
    flags.push(`pronunciación a revisar ⚠️ (${unconfirmedNames.map((c) => c.name).join(', ')} — ver clip en name-check/)`);
  }

  if (report.namePacingIssues.length > 0) {
    flags.push(`nombre pegado a palabra vecina ⚠️ (${report.namePacingIssues.map((c) => c.name).join(', ')} — ver clip en name-check/)`);
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

  if (report.nisqa.score !== null) {
    const ns = report.nisqa.score;
    if (ns >= 75) flags.push(`NISQA: ${ns}/100 ✓`);
    else if (ns >= 50) flags.push(`NISQA: ${ns}/100 ⚠️ (mediocre)`);
    else flags.push(`NISQA: ${ns}/100 ⚠️ (baja calidad)`);
  } else if (report.nisqa.error) {
    flags.push('NISQA: no disponible');
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
    unconfirmedNames.length > 0 ||
    report.namePacingIssues.length > 0 ||
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

    if (report.nameAudioChecks && report.nameAudioChecks.length > 0) {
      for (const c of report.nameAudioChecks) {
        if (c.confirmed === false) {
          console.log(`   🎧 "${c.name}" (escrito "${c.spelledAs}"): la transcripción CON pista de letra lo dio por presente, pero SIN pista dio "${c.unprimedText || '(nada)'}" — posible mala pronunciación real. Clip: ${c.clipPath}`);
        } else if (c.confirmed === null && c.error) {
          console.log(`   🎧 "${c.name}": no se pudo re-chequear la pronunciación (${c.error})`);
        }
      }
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

    if (report.namePacingIssues && report.namePacingIssues.length > 0) {
      for (const p of report.namePacingIssues) {
        const withPrev = p.mergedBefore && p.prevWord ? `"${p.prevWord.word}"+"${p.spelledAs}" (hueco ${Math.round(p.gapBeforeS * 1000)}ms)` : null;
        const withNext = p.mergedAfter && p.nextWord ? `"${p.spelledAs}"+"${p.nextWord.word}" (hueco ${Math.round(p.gapAfterS * 1000)}ms)` : null;
        const detail = [withPrev, withNext].filter(Boolean).join(' | ');
        console.log(`   🗣️  "${p.name}" pegado a la palabra vecina sin pausa: ${detail}${p.clipPath ? ` — Clip: ${p.clipPath}` : ''}`);
      }
    }

    if (report.pacingIssues && report.pacingIssues.length > 0) {
      console.log(`   🗣️  ${report.pacingIssues.length} pares de palabras posiblemente pegadas sin pausa en toda la letra (informativo, confirmá con tu oído):`);
      for (const pair of report.pacingIssues.slice(0, 5)) {
        const ts = `${Math.floor(pair.timestamp / 60)}:${String(Math.floor(pair.timestamp % 60)).padStart(2, '0')}`;
        console.log(`     • "${pair.wordA}"+"${pair.wordB}" @${ts} (hueco ${Math.round(pair.gapS * 1000)}ms)`);
      }
      if (report.pacingIssues.length > 5) {
        console.log(`     ... y ${report.pacingIssues.length - 5} más`);
      }
    }

    if (report.truncatedWords && report.truncatedWords.length > 0) {
      console.log(`   ✂️  ${report.truncatedWords.length} palabra(s) posiblemente cortada(s) a la mitad (informativo, confirmá con tu oído):`);
      for (const t of report.truncatedWords.slice(0, 5)) {
        const ts = `${Math.floor(t.start / 60)}:${String(Math.floor(t.start % 60)).padStart(2, '0')}`;
        const volNote = t.volumeDropConfirmed ? ` — caída de volumen confirmada (${t.volumeDropDb}dB)` : '';
        console.log(`     • "${t.word}" @${ts} (${t.actualDurationS}s vs ${t.expectedMinDurationS}s esperados, prob ${t.probability})${volNote}${t.clipPath ? ` — Clip: ${t.clipPath}` : ''}`);
      }
      if (report.truncatedWords.length > 5) {
        console.log(`     ... y ${report.truncatedWords.length - 5} más`);
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

    // NISQA — MOS detallado por dimensión
    if (report.nisqa.score !== null && report.nisqa.dimensions) {
      const d = report.nisqa.dimensions;
      const dimLabels = {
        noisiness: 'Ruido',
        discontinuity: 'Discontinuidad',
        coloration: 'Coloración',
        loudness: 'Volumen',
      };
      const parts = Object.entries(d).map(([k, v]) => `${dimLabels[k] || k}: ${v}`).join(' | ');
      console.log(`   🗣️  NISQA score: ${report.nisqa.score}/100 (MOS ${report.nisqa.mos}) — ${parts}`);
    } else if (report.nisqa.error) {
      console.log(`   🗣️  NISQA: no disponible (${report.nisqa.error.substring(0, 60)})`);
    }

    // MuQ-Eval — calidad musical percibida (informativo, 0 pts)
    if (report.muqEval && report.muqEval.score !== null) {
      console.log(`   🎼 MuQ-Eval: ${report.muqEval.score}/5 (±${report.muqEval.scoreStd} entre ${report.muqEval.nClips} ventanas de 10s) — informativo, sin calibrar`);
    } else if (report.muqEval && report.muqEval.error) {
      console.log(`   🎼 MuQ-Eval: no disponible (${report.muqEval.error.substring(0, 60)})`);
    }

    // Audiobox Aesthetics — calidad de producción (informativo, 0 pts)
    if (report.audiobox && report.audiobox.pq !== null) {
      console.log(`   🎚️  Audiobox: PQ ${report.audiobox.pq}/10 — Complejidad ${report.audiobox.pc} | Disfrute ${report.audiobox.ce} | Utilidad ${report.audiobox.cu} — informativo, sin calibrar`);
    } else if (report.audiobox && report.audiobox.error) {
      console.log(`   🎚️  Audiobox: no disponible (${report.audiobox.error.substring(0, 60)})`);
    }

    const t = report.timing;
    const timingParts = [];
    if (t.demucsMs !== null) timingParts.push(`demucs ${formatElapsed(t.demucsMs)}`);
    if (t.whisperMs !== null) timingParts.push(`whisper ${formatElapsed(t.whisperMs)}`);
    if (t.clapMs !== null) timingParts.push(`clap ${formatElapsed(t.clapMs)}`);
    if (t.nisqaMs !== null) timingParts.push(`nisqa ${formatElapsed(t.nisqaMs)}`);
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
  // Segunda opinión sin pista de la letra (ver verifyNamePronunciation):
  // señal más nueva/experimental que missingNames, penaliza menos fuerte.
  if ((report.nameAudioChecks || []).some((c) => c.confirmed === false)) score -= 15;
  // Nombre pegado a la palabra vecina sin pausa (ver checkNamePacing): señal
  // determinística (aritmética de timestamps, no un modelo difuso) — tan
  // confiable como missingNames/nameAudioChecks, mismo peso.
  if ((report.namePacingIssues || []).length > 0) score -= 15;
  if (report.demucs.vocalPresence === true) score -= 30; // instrumental accidental
  // CLAP — señal informativa de calidad perceptual (max ±15 pts).
  // Peso deliberadamente bajo hasta validar correlación con oído humano.
  // Si CLAP no corrió (error/no instalado): 0 pts, no penaliza ni bonifica.
  if (report.clap && report.clap.score !== null) {
    if (report.clap.score < 50) score -= 15;        // producción inaceptable
    else if (report.clap.score < 70) score -= 5;     // producción mediocre
    else if (report.clap.score > 85) score += 5;     // producción excelente
  }
  // NISQA — MOS de naturalidad de voz (max ±10 pts). Peso más conservador
  // que CLAP: señal nueva sin validar en vivo todavía (mismo criterio que se
  // aplicó a CLAP y a la pronunciación de nombres — subir el peso más
  // adelante si se confirma que correlaciona con el oído humano).
  // Si NISQA no corrió (error/no instalado): 0 pts, no penaliza ni bonifica.
  if (report.nisqa && report.nisqa.score !== null) {
    if (report.nisqa.score < 50) score -= 10;        // voz inaceptable
    else if (report.nisqa.score < 70) score -= 4;     // voz mediocre
    else if (report.nisqa.score > 85) score += 4;     // voz excelente
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
    // Mejora pedida por Hector (auditoría 2026-07-10): el tie-break no
    // distinguía "A y B son ambas excelentes y empatan" (ej. "Sábado Veinte
    // de Septiembre", "Veinticinco Veranos" — funcionó bien) de "A y B
    // comparten el mismo defecto grave" (ej. "Mi promesa": 57=57 con
    // fidelidad de letra baja Y voz indeterminada en las dos) — antes se
    // comportaban igual. Ahora el empate reporta explícitamente qué defectos
    // reales comparten, si los hay, en vez de sonar a "las dos están bien".
    const sharedIssues = [];
    if (reportA.durationOk === false && reportB.durationOk === false) sharedIssues.push('duración fuera de rango en ambas');
    if ((reportA.levenshteinScore ?? 1) < 0.75 && (reportB.levenshteinScore ?? 1) < 0.75) sharedIssues.push('fidelidad de letra baja en ambas (< 75%)');
    if ((reportA.missingNames || []).length > 0 && (reportB.missingNames || []).length > 0) sharedIssues.push('nombres ausentes en ambas');
    if (reportA.clippingFlag && reportB.clippingFlag) sharedIssues.push('clipping en ambas');
    if (reportA.abruptCutoff && reportB.abruptCutoff) sharedIssues.push('corte abrupto en ambas');

    const reason = sharedIssues.length > 0
      ? `Empate técnico (${scoreA} puntos cada una) — OJO: no es un empate de calidad, comparten problemas reales (${sharedIssues.join('; ')}). Se recomienda A por defecto, pero revisá de oído antes de confiar en la recomendación.`
      : `Empate técnico (${scoreA} puntos cada una). Se recomienda A por defecto.`;

    return { recommended: 'A', reason, scoreA, scoreB, sharedIssues };
  }
}

module.exports = {
  analyzeAudio,
  prepareVocals,
  cleanupVocalsTmp,
  transcribeFiles,
  runClapScore,
  runClapScoreWithVocalIsolation,
  runNisqaScore,
  runMuqEvalScore,
  runAudioboxScore,
  runF0GenderCheck,
  reconcileF0Octave,
  resolveVocalOrMixPaths,
  checkNamePacing,
  detectMergedWordPairs,
  detectTruncatedWords,
  countVowelsEs,
  computeMissingNames,
  isNameInTranscription,
  checkLoudness,
  printReport,
  pickBestVersion,
  getDurationAsync,
  formatDuration,
  formatElapsed,
  SONG_PATH,
  parseLyricsFromSongFile,
  parseTituloFromSongFile,
  stripStructuralTags,
  extractStructuralTags,
  lastMeaningfulLine,
  batchFileMismatch,
};
