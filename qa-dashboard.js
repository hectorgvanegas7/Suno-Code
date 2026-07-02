const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.json());

const REPORT_PATH = path.join(__dirname, 'verify-report.json');
const SONG_PATH = path.join(__dirname, 'song.txt');
const SURVEY_PATH = path.join(__dirname, 'survey.txt');
const SUNO_DIR = path.join(require('os').homedir(), 'Downloads', 'suno');

// Serve MP3 files
app.use('/audio', express.static(SUNO_DIR));

// Arma la tarjeta de una versión (A o B) — misma estructura para ambas,
// solo cambian los datos que recibe.
function renderVersionCard({ label, versionReport, score, filename, fileExists, isRecommended }) {
  const letraMatch = versionReport ? Math.round((versionReport.levenshteinScore || 0) * 100) : 0;
  const audioTag = fileExists
    ? `<audio controls src="/audio/${filename}"></audio>`
    : '<p style="color:red; font-size: 12px; margin: 0.75rem 0 0 0;">MP3 no encontrado</p>';

  return `
    <div class="version-card ${isRecommended ? 'recommended' : ''}">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <h3 style="margin:0; font-size: 1.1rem;">Versión ${label}</h3>
        <span style="font-weight:bold; font-size: 1.1rem; color: var(--primary);">${score ?? 'N/A'} pts</span>
      </div>
      <div style="margin-top: 0.5rem; display: flex; flex-wrap: wrap; gap: 0.25rem;">
        <span class="badge ${versionReport?.durationOk ? 'badge-success' : 'badge-warning'}">Duración: ${versionReport?.durationFormatted || 'N/A'}</span>
        <span class="badge ${versionReport?.abruptCutoff ? 'badge-warning' : 'badge-success'}">${versionReport?.abruptCutoff ? 'Corte Abrupto' : 'Fade Out Ok'}</span>
        <span class="badge ${versionReport?.clippingFlag ? 'badge-warning' : 'badge-success'}">${versionReport?.clippingFlag ? 'Clipping' : 'Sin Clipping'}</span>
        <span class="badge badge-success">Letra: ${letraMatch}% match</span>
      </div>
      ${audioTag}
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
  <style>
    :root {
      --bg: #0f172a;
      --surface: #1e293b;
      --primary: #3b82f6;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --success: #10b981;
      --warning: #f59e0b;
    }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 1.5rem;
    }
    .grid {
      display: grid;
      grid-template-columns: 1.150fr 1.150fr 1.3fr;
      gap: 1.5rem;
      max-width: 1600px;
      margin: 0 auto;
    }
    .card {
      background: var(--surface);
      padding: 1.5rem;
      border-radius: 1rem;
      box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);
      display: flex;
      flex-direction: column;
      height: calc(100vh - 5rem);
      box-sizing: border-box;
    }
    .card-title {
      font-size: 1.4rem;
      font-weight: bold;
      margin-top: 0;
      margin-bottom: 1rem;
      border-bottom: 1px solid #334155;
      padding-bottom: 0.5rem;
    }
    .scrollable-content {
      flex: 1;
      overflow-y: auto;
      background: #0f172a;
      border-radius: 0.5rem;
      padding: 1rem;
    }
    .lyrics {
      white-space: pre-wrap;
      font-family: monospace;
      font-size: 14px;
      color: var(--text);
      line-height: 1.6;
    }
    .survey-block {
      font-size: 13.5px;
      line-height: 1.6;
      color: var(--text-muted);
      margin-bottom: 1rem;
    }
    .survey-question {
      font-weight: bold;
      color: var(--text);
      display: block;
      margin-bottom: 0.2rem;
    }
    .survey-answer {
      background: rgba(255,255,255,0.02);
      padding: 0.5rem;
      border-radius: 0.25rem;
      border-left: 2px solid var(--primary);
    }
    .version-card {
      margin-bottom: 1.2rem;
      padding: 1.2rem;
      border-radius: 0.75rem;
      border: 1px solid #334155;
      background: rgba(15, 23, 42, 0.4);
    }
    .version-card.recommended {
      border-color: var(--success);
      background: rgba(16, 185, 129, 0.04);
    }
    .badge {
      display: inline-block;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      font-size: 0.75rem;
      font-weight: bold;
      margin-right: 0.5rem;
      margin-bottom: 0.5rem;
    }
    .badge-success { background: var(--success); color: white; }
    .badge-warning { background: var(--warning); color: black; }
    audio { width: 100%; margin-top: 0.75rem; }
    .alert-box {
      background: rgba(59, 130, 246, 0.1);
      border: 1px solid var(--primary);
      color: var(--text);
      padding: 1rem;
      border-radius: 0.5rem;
      font-size: 14px;
      text-align: center;
      margin-top: auto;
    }
  </style>
</head>
<body>
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

        <div class="alert-box">
          👉 <strong>Escucha las versiones arriba.</strong><br>
          Confirma tu decisión ingresando tu opción en la terminal de tu computadora.
        </div>
      </div>
    </div>
  </div>
</body>
</html>
  `;

  res.send(html);
});

app.listen(PORT, () => {
  console.log(`QA Dashboard (modo lectura) corriendo en http://localhost:${PORT}`);
});
