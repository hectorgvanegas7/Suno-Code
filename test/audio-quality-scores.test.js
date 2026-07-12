// test/audio-quality-scores.test.js — Suite de regresión local para las 2
// señales de calidad musical nuevas: runMuqEvalScore (MuQ-Eval) y
// runAudioboxScore (Audiobox Aesthetics) en lib/audio-analysis.js.
//
// 100% offline: nunca invoca Python real. Los caminos felices usan un
// intérprete `python3` STUB (script de shell que imprime un archivo JSON con
// el mismo shape documentado en lib/muq_eval_score.py / lib/audiobox_score.py).
// El stub tiene que instalarse en PATH ANTES de requerir lib/audio-analysis:
// PYTHON_UTF8_ENV es un snapshot de process.env al momento del require, así
// que un PATH cambiado a mitad de test es invisible para spawnSync (lección
// aprendida escribiendo esta misma suite). En Windows no se puede shimear
// `python` sin un .cmd (que spawnSync sin shell no resuelve) — esos tests se
// saltean ahí; los de graceful degrade corren en todas las plataformas.
// Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const isWindows = process.platform === 'win32';

// ── Stub de python3 instalado ANTES del require (ver comentario de arriba) ──
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'py-stub-'));
const STUB_JSON_FILE = path.join(stubDir, 'stub-output.json');
if (!isWindows) {
  fs.writeFileSync(path.join(stubDir, 'python3'), `#!/bin/sh\ncat "${STUB_JSON_FILE}"\n`, { mode: 0o755 });
  process.env.PATH = `${stubDir}${path.delimiter}${process.env.PATH}`;
}

const { runMuqEvalScore, runAudioboxScore, batchFileMismatch } = require('../lib/audio-analysis');

function withStubOutput(json, fn) {
  fs.writeFileSync(STUB_JSON_FILE, JSON.stringify(json), 'utf-8');
  try {
    return fn();
  } finally {
    fs.rmSync(STUB_JSON_FILE, { force: true });
  }
}

test.after(() => {
  fs.rmSync(stubDir, { recursive: true, force: true });
});

// ── Graceful degrade (todas las plataformas, sin stub) ──────────────────────

test('runMuqEvalScore: python roto/salida vacía NO lanza — error por-resultado y estructura completa', () => {
  // Sin archivo de stub, el python3 fake imprime nada (cat de archivo
  // inexistente) → "no produjo salida". En Windows (sin stub) el python real
  // o su ausencia también termina en error por-resultado. En ambos casos el
  // contrato es el mismo: nunca lanzar, un resultado por archivo pedido.
  const outcome = runMuqEvalScore(['/no/existe/a.mp3', '/no/existe/b.mp3']);
  assert.equal(outcome.results.length, 2);
  for (const r of outcome.results) {
    assert.ok(r.error, `esperaba error por-resultado, vino: ${JSON.stringify(r)}`);
    assert.equal(r.score, null);
    assert.equal(r.scoreStd, null);
    assert.equal(r.nClips, null);
  }
});

test('runAudioboxScore: python roto/salida vacía NO lanza — error por-resultado y estructura completa', () => {
  const outcome = runAudioboxScore(['/no/existe/a.mp3']);
  assert.equal(outcome.results.length, 1);
  const r = outcome.results[0];
  assert.ok(r.error);
  assert.equal(r.pq, null);
  assert.equal(r.pc, null);
  assert.equal(r.ce, null);
  assert.equal(r.cu, null);
});

// ── Caminos felices y de mismatch con el stub (no-Windows) ──────────────────

test('runMuqEvalScore: camino feliz — mapea score/scoreStd/nClips por archivo', { skip: isWindows }, () => {
  const files = ['/audio/Version A.mp3', '/audio/Version B.mp3'];
  const batch = {
    batch: true,
    results: [
      { file: files[0], score: 3.84, score_std: 0.31, n_clips: 18, elapsed_ms: 950 },
      { file: files[1], score: 4.12, score_std: 0.22, n_clips: 18, elapsed_ms: 870 },
    ],
  };
  const outcome = withStubOutput(batch, () => runMuqEvalScore(files));
  assert.equal(outcome.results[0].error, null, `sin error esperado: ${outcome.results[0].error}`);
  assert.equal(outcome.results[0].score, 3.84);
  assert.equal(outcome.results[0].elapsedMs, 950);
  assert.equal(outcome.results[1].score, 4.12);
  assert.equal(outcome.results[1].scoreStd, 0.22);
  assert.equal(outcome.results[1].nClips, 18);
  assert.equal(typeof outcome.muqMs, 'number');
});

test('runAudioboxScore: camino feliz — mapea pq/pc/ce/cu y aísla el error por archivo', { skip: isWindows }, () => {
  const files = ['/audio/Version A.mp3', '/audio/Version B.mp3'];
  const batch = {
    batch: true,
    results: [
      { file: files[0], pq: 7.22, pc: 2.15, ce: 5.15, cu: 5.78, elapsed_ms: 400 },
      { file: files[1], error: 'archivo corrupto', elapsed_ms: 12 },
    ],
  };
  const outcome = withStubOutput(batch, () => runAudioboxScore(files));
  assert.equal(outcome.results[0].pq, 7.22);
  assert.equal(outcome.results[0].cu, 5.78);
  assert.equal(outcome.results[0].error, null);
  assert.equal(outcome.results[1].error, 'archivo corrupto', 'el error de B no debe contaminar a A ni perderse');
  assert.equal(outcome.results[1].pq, null);
});

test('runMuqEvalScore: resultados cruzados por Python se detectan como mismatch en vez de atribuirse mal', { skip: isWindows }, () => {
  // Regresión del cruce silencioso A/B — mismo bug real que motivó
  // batchFileMismatch para transcribe/CLAP/NISQA (test/python-batch-order.test.js).
  const files = ['/audio/Version A.mp3', '/audio/Version B.mp3'];
  const batch = {
    batch: true,
    results: [
      { file: files[1], score: 4.12, score_std: 0.2, n_clips: 18, elapsed_ms: 1 }, // ¡cruzado!
      { file: files[0], score: 3.84, score_std: 0.3, n_clips: 18, elapsed_ms: 1 },
    ],
  };
  const outcome = withStubOutput(batch, () => runMuqEvalScore(files));
  assert.match(outcome.results[0].error || '', /MuQ-Eval devolvió/);
  assert.equal(outcome.results[0].score, null);
});

test('runMuqEvalScore: error global del script (repo/deps faltantes) se propaga a todos los resultados', { skip: isWindows }, () => {
  const files = ['/audio/Version A.mp3', '/audio/Version B.mp3'];
  const globalError = { error: 'Repo MuQ-Eval no encontrado. Cloná https://github.com/dgtql/MuQ-Eval y seteá MUQ_EVAL_DIR.' };
  const outcome = withStubOutput(globalError, () => runMuqEvalScore(files));
  assert.match(outcome.results[0].error, /MuQ-Eval no encontrado/);
  assert.match(outcome.results[1].error, /MuQ-Eval no encontrado/);
});

test('runAudioboxScore: al modelo le falta un resultado — el archivo sin resultado recibe error, el otro no', { skip: isWindows }, () => {
  const files = ['/audio/Version A.mp3', '/audio/Version B.mp3'];
  const batch = { batch: true, results: [{ file: files[0], pq: 7.0, pc: 2.0, ce: 5.0, cu: 5.0, elapsed_ms: 5 }] };
  const outcome = withStubOutput(batch, () => runAudioboxScore(files));
  assert.equal(outcome.results[0].pq, 7.0);
  assert.match(outcome.results[1].error, /no devolvió resultado/);
});

// ── batchFileMismatch aplicado al shape nuevo (todas las plataformas) ───────

test('batchFileMismatch sobre el shape de los .py nuevos: mismo archivo pasa, cruzado se reporta', () => {
  const a = path.join('audio', 'Version A.mp3');
  const b = path.join('audio', 'Version B.mp3');
  assert.equal(batchFileMismatch(a, a), null);
  assert.ok(batchFileMismatch(a, b));
});
