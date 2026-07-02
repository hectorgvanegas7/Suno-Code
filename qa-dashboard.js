const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const pipelineState = require('./lib/pipeline-state');
const { notify } = require('./lib/ntfy');

const app = express();
const PORT = 3000;

app.use(express.json());

const REPORT_PATH = path.join(__dirname, 'verify-report.json');
const SONG_PATH = path.join(__dirname, 'song.txt');
const SURVEY_PATH = path.join(__dirname, 'survey.txt');
const SUNO_DIR = path.join(require('os').homedir(), 'Downloads', 'suno');

// Serve MP3 files and static dashboard assets (CSS/JS)
app.use('/audio', express.static(SUNO_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Centro de control: aprobar-y-subir desde la web ──────────────────────────
// Este dashboard puede correr standalone (`node qa-dashboard.js`, solo lectura
// + acción) o forkeado por start-flow.js (con canal IPC). Cuando hay IPC
// (`process.send` existe), cada decisión final se le avisa al padre para que
// deje de esperar el viejo prompt de terminal — ver runFlow() en start-flow.js.
const decisionState = {
  status: 'pending', // 'pending' | 'uploading' | 'uploaded' | 'upload-failed' | 'rejected'
  version: null,
  log: [],
  error: null,
};

// La sesión del Flow tiene un límite duro de ~30 min desde que se asigna la
// canción. Si a los 20 min todavía no hay decisión, un solo aviso push (no
// repetido) para que Hector no se quede sin tiempo dentro del Flow.
const SESSION_WARNING_MIN = 20;
const SESSION_LIMIT_MIN = 30;
let reminderSent = false;

function sessionElapsedMin() {
  const st = pipelineState.read();
  if (!st || !st.startedAt) return null;
  return (Date.now() - new Date(st.startedAt).getTime()) / 60000;
}

const reminderInterval = setInterval(() => {
  if (decisionState.status !== 'pending') return;
  const elapsed = sessionElapsedMin();
  if (elapsed !== null && elapsed >= SESSION_WARNING_MIN && !reminderSent) {
    reminderSent = true;
    notify(
      `⏰ Van ${Math.round(elapsed)} min de sesión y todavía no aprobaste una versión en el dashboard (límite ~${SESSION_LIMIT_MIN} min).`,
      { title: 'Canción Eterna: decisión pendiente', priority: 'high', tags: 'alarm_clock' }
    ).catch(() => {});
  }
}, 30000);
reminderInterval.unref();

// Avisa al proceso padre (start-flow.js) la decisión final, si hay canal IPC.
function notifyParent() {
  if (typeof process.send === 'function') {
    process.send({
      type: 'decision',
      decision: decisionState.status,
      version: decisionState.version,
      error: decisionState.error,
    });
  }
}

// Corre upload-to-flow.js como proceso hijo (mismo patrón que start-flow.js
// usa para sus propios pasos) y refleja el resultado en decisionState.
function runUpload(version) {
  decisionState.status = 'uploading';
  decisionState.version = version;
  decisionState.log = [];
  decisionState.error = null;

  const child = spawn('node', ['upload-to-flow.js', '--version', version], { cwd: __dirname });
  child.stdout.on('data', (chunk) => decisionState.log.push(chunk.toString()));
  child.stderr.on('data', (chunk) => decisionState.log.push(chunk.toString()));
  child.on('exit', (code) => {
    if (code === 0) {
      decisionState.status = 'uploaded';
    } else {
      decisionState.status = 'upload-failed';
      decisionState.error = `upload-to-flow.js terminó con código ${code}`;
    }
    notifyParent();
  });
  child.on('error', (e) => {
    decisionState.status = 'upload-failed';
    decisionState.error = e.message;
    notifyParent();
  });
}

app.post('/approve', (req, res) => {
  const version = String((req.body || {}).version || '').toUpperCase();
  if (!['A', 'B'].includes(version)) {
    return res.status(400).json({ ok: false, error: 'version debe ser A o B' });
  }
  if (decisionState.status !== 'pending') {
    return res.status(409).json({ ok: false, error: `Ya hay una decisión en curso/tomada: ${decisionState.status}` });
  }
  runUpload(version);
  res.json({ ok: true });
});

app.post('/reject', (req, res) => {
  if (decisionState.status !== 'pending') {
    return res.status(409).json({ ok: false, error: `Ya hay una decisión en curso/tomada: ${decisionState.status}` });
  }
  decisionState.status = 'rejected';
  notifyParent();
  res.json({ ok: true });
});

app.get('/status', (req, res) => {
  const elapsed = sessionElapsedMin();
  res.json({
    ...decisionState,
    elapsedMin: elapsed !== null ? Math.round(elapsed) : null,
    sessionLimitMin: SESSION_LIMIT_MIN,
  });
});

// Detalle expandible de los chequeos individuales de verify-audio.js para
// una versión (los mismos campos que resumen los badges, desglosados).
function renderQaDetail(versionReport) {
  if (!versionReport) {
    return `
      <details class="qa-detail">
        <summary>Ver detalle QA</summary>
        <p class="qa-detail-empty">Sin datos de análisis para esta versión.</p>
      </details>
    `;
  }

  const missingNames = versionReport.missingNames || [];
  const tagLeaking = versionReport.tagLeaking || [];
  const letraOk = (versionReport.levenshteinScore || 0) >= 0.75;

  const checks = [
    { label: 'Duración en rango', ok: versionReport.durationOk, detail: versionReport.durationFormatted || 'N/A' },
    { label: 'Fade out (sin corte abrupto)', ok: !versionReport.abruptCutoff },
    { label: 'Sin clipping', ok: !versionReport.clippingFlag },
    { label: 'Título no cantado', ok: !versionReport.titleCantado },
    { label: 'Sin tags cantados', ok: !tagLeaking.length, detail: tagLeaking.join(', ') },
    { label: 'Nombres presentes en el audio', ok: !missingNames.length, detail: missingNames.length ? `faltan: ${missingNames.join(', ')}` : '' },
    { label: 'Match de letra (Levenshtein)', ok: letraOk, detail: `${Math.round((versionReport.levenshteinScore || 0) * 100)}%` },
  ];

  // CLAP dimensions (si están disponibles)
  const clap = versionReport.clap || {};
  let clapHtml = '';
  if (clap.score !== null && clap.score !== undefined && clap.dimensions) {
    const dimLabels = {
      vocal_clarity: 'Claridad vocal',
      production: 'Producción',
      emotion: 'Emoción',
      artifacts: 'Artefactos',
      ending: 'Final',
    };
    const dimRows = Object.entries(clap.dimensions).map(([k, v]) => {
      const ok = v >= 60;
      return `
        <li>
          <span class="qa-check-icon ${ok ? 'qa-check-ok' : 'qa-check-warn'}">${ok ? '✓' : '⚠'}</span>
          <span>${dimLabels[k] || k}: ${v}/100</span>
        </li>
      `;
    }).join('');
    clapHtml = `
      <li style="margin-top: 0.5rem; font-weight: 600; list-style: none;">🎧 CLAP Score Global: ${clap.score}/100</li>
      ${dimRows}
    `;
  } else if (clap.error) {
    clapHtml = `
      <li style="margin-top: 0.5rem; list-style: none;">
        <span class="qa-check-icon qa-check-warn">⚠</span>
        <span>CLAP: no disponible</span>
      </li>
    `;
  }
  const passCount = checks.filter((c) => c.ok).length;

  const rows = checks
    .map(
      (c) => `
        <li>
          <span class="qa-check-icon ${c.ok ? 'qa-check-ok' : 'qa-check-warn'}">${c.ok ? '✓' : '⚠'}</span>
          <span>${c.label}${c.detail ? ` — ${c.detail}` : ''}</span>
        </li>
      `
    )
    .join('');

  return `
    <details class="qa-detail">
      <summary>Ver detalle QA (${passCount}/${checks.length})</summary>
      <ul class="qa-check-list">${rows}${clapHtml}</ul>
      ${versionReport.summary ? `<p class="qa-summary-text">${versionReport.summary}</p>` : ''}
    </details>
  `;
}

// Arma la tarjeta de una versión (A o B) — misma estructura para ambas,
// solo cambian los datos que recibe.
function renderVersionCard({ label, versionReport, score, filename, fileExists, isRecommended }) {
  const letraMatch = versionReport ? Math.round((versionReport.levenshteinScore || 0) * 100) : 0;
  const audioId = `audio-${label}`;
  const audioTag = fileExists
    ? `
      <audio id="${audioId}" data-version="${label}" controls src="/audio/${filename}"></audio>
      <div class="audio-controls">
        <button type="button" class="play-btn" data-audio-target="${audioId}">▶ Reproducir</button>
        <span class="now-playing" data-now-playing="${label}">🔊 Sonando</span>
      </div>
    `
    : '<p style="color:red; font-size: 12px; margin: 0.75rem 0 0 0;">MP3 no encontrado</p>';

  const approveBtn = fileExists
    ? `<button type="button" class="approve-btn" data-approve-version="${label}">🟢 Aprobar y Subir Versión ${label}</button>`
    : `<button type="button" class="approve-btn" disabled>MP3 no disponible</button>`;

  return `
    <div class="version-card ${isRecommended ? 'recommended' : ''}" data-version-card="${label}">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <h3 style="margin:0; font-size: 1.1rem;">Versión ${label}${isRecommended ? '<span class="recommended-pill">RECOMENDADA</span>' : ''}</h3>
        <span style="font-weight:bold; font-size: 1.1rem; color: var(--primary);">${score ?? 'N/A'} pts</span>
      </div>
      <div style="margin-top: 0.5rem; display: flex; flex-wrap: wrap; gap: 0.25rem;">
        <span class="badge ${versionReport?.durationOk ? 'badge-success' : 'badge-warning'}">Duración: ${versionReport?.durationFormatted || 'N/A'}</span>
        <span class="badge ${versionReport?.abruptCutoff ? 'badge-warning' : 'badge-success'}">${versionReport?.abruptCutoff ? 'Corte Abrupto' : 'Fade Out Ok'}</span>
        <span class="badge ${versionReport?.clippingFlag ? 'badge-warning' : 'badge-success'}">${versionReport?.clippingFlag ? 'Clipping' : 'Sin Clipping'}</span>
        <span class="badge badge-success">Letra: ${letraMatch}% match</span>
        ${(() => {
          const clap = versionReport?.clap || {};
          if (clap.score !== null && clap.score !== undefined) {
            const cls = clap.score >= 75 ? 'badge-success' : clap.score >= 50 ? 'badge-warning' : 'badge-danger';
            return `<span class="badge ${cls}">🎧 CLAP: ${clap.score}/100</span>`;
          } else if (clap.error) {
            return `<span class="badge badge-muted">🎧 CLAP: N/A</span>`;
          }
          return '';
        })()}
      </div>
      ${audioTag}
      ${approveBtn}
      ${renderQaDetail(versionReport)}
    </div>
  `;
}

app.get('/', (req, res) => {
  let report = null;
  let songText = '';
  let surveyText = '';

  try {
    report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf-8'));
  } catch (e) {
    return res.status(500).send('Error reading verify-report.json. Is the audio analysis complete?');
  }

  try {
    songText = fs.readFileSync(SONG_PATH, 'utf-8');
  } catch (e) {
    songText = '(No se encontró song.txt)';
  }

  try {
    surveyText = fs.readFileSync(SURVEY_PATH, 'utf-8');
  } catch (e) {
    surveyText = '(No se encontró survey.txt)';
  }

  // Los MP3 de esta canción ya están identificados por verify-audio.js
  // (lib/audio-match.js filtra por título + recencia). Usar esas rutas en
  // vez de re-escanear Downloads/suno/ por mtime, que puede agarrar el MP3
  // de otra canción generada el mismo día.
  const versionAPath = report.reportA?.path;
  const versionBPath = report.reportB?.path;
  const versionA = versionAPath ? path.basename(versionAPath) : null;
  const versionB = versionBPath ? path.basename(versionBPath) : null;
  const versionAExists = versionA && fs.existsSync(path.join(SUNO_DIR, versionA));
  const versionBExists = versionB && fs.existsSync(path.join(SUNO_DIR, versionB));

  // report.recommendation puede faltar si verify-audio.js analizó solo 1
  // version o terminó antes de tiempo. Sin este fallback, leer .recommended
  // más abajo tira una excepción no capturada y el dashboard responde un
  // 500 sin mensaje útil.
  const recommendation = report.recommendation || {
    recommended: null,
    reason: 'Recomendación no disponible (análisis incompleto).',
    scoreA: null,
    scoreB: null,
  };

  const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>QA Dashboard - Canción Eterna</title>
  <link rel="stylesheet" href="/dashboard.css">
</head>
<body>
  <div id="session-timer" class="session-timer">⏱️ Sesión del Flow: <span id="elapsed-min">?</span> / ${SESSION_LIMIT_MIN} min</div>
  <div class="grid">
    <!-- COL 1: SURVEY -->
    <div>
      <div class="card">
        <div class="card-title">Respuestas de Encuesta</div>
        <div class="scrollable-content" style="background: transparent; padding: 0;">
          ${surveyText.split('\n').filter(line => line.trim()).map(line => {
            const parts = line.split(':');
            const question = parts[0] ? parts[0].trim() : '';
            const answer = parts.slice(1).join(':').trim();
            return `
              <div class="survey-block">
                <span class="survey-question">${question}</span>
                <div class="survey-answer">${answer || '(Sin respuesta)'}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    </div>

    <!-- COL 2: LYRICS -->
    <div>
      <div class="card">
        <div class="card-title">${report.titulo || 'Canción'}</div>
        <div class="scrollable-content">
          <div class="lyrics">${songText}</div>
        </div>
      </div>
    </div>
    
    <!-- COL 3: AUDIT & AUDIO -->
    <div>
      <div class="card" style="height: auto; max-height: calc(100vh - 5rem);">
        <div class="card-title">Auditoría de Audio</div>
        <p style="color: var(--text-muted); margin-top: 0; margin-bottom: 1.2rem; font-size: 13.5px;">
          Recomendación: <strong style="color: var(--success);">${recommendation.recommended ? `Versión ${recommendation.recommended}` : 'N/A'}</strong><br>
          <small>${recommendation.reason}</small>
        </p>

        <div style="overflow-y: auto; flex: 1; padding-right: 0.25rem;">
          ${renderVersionCard({
            label: 'A',
            versionReport: report.reportA,
            score: recommendation.scoreA,
            filename: versionA,
            fileExists: versionAExists,
            isRecommended: recommendation.recommended === 'A',
          })}
          ${renderVersionCard({
            label: 'B',
            versionReport: report.reportB,
            score: recommendation.scoreB,
            filename: versionB,
            fileExists: versionBExists,
            isRecommended: recommendation.recommended === 'B',
          })}
        </div>

        <div id="decision-panel" class="decision-panel">
          <div id="decision-idle">
            <p style="margin: 0 0 0.75rem 0;">👉 Escuchá ambas versiones y aprobá una arriba, o rechazá las dos para revisar manualmente.</p>
            <button type="button" id="reject-btn" class="reject-btn">✋ No subir ninguna (revisar manual)</button>
          </div>
          <div id="decision-busy" class="decision-busy" style="display:none;">⏳ Subiendo Versión <span id="busy-version"></span> al Flow...</div>
          <div id="decision-done" class="decision-done" style="display:none;"></div>
        </div>
      </div>
    </div>
  </div>
  <script src="/dashboard.client.js"></script>
</body>
</html>
  `;

  res.send(html);
});

app.listen(PORT, () => {
  console.log(`QA Dashboard corriendo en http://localhost:${PORT}`);
  // Auto-open browser
  require('child_process').exec(`start http://localhost:${PORT}`);
});
