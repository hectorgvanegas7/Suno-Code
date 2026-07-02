// Control propio de reproducción: al reproducir una versión, pausa la otra
// y marca visualmente cuál está sonando. No reemplaza los controles nativos
// del <audio> (seek/volumen), los complementa.
document.addEventListener('DOMContentLoaded', () => {
  const audios = Array.from(document.querySelectorAll('audio[data-version]'));

  function updateIndicators() {
    audios.forEach((audio) => {
      const version = audio.dataset.version;
      const indicator = document.querySelector(`[data-now-playing="${version}"]`);
      const button = document.querySelector(`[data-audio-target="${audio.id}"]`);
      const isPlaying = !audio.paused && !audio.ended;
      if (indicator) indicator.classList.toggle('visible', isPlaying);
      if (button) button.textContent = isPlaying ? '⏸ Pausar' : '▶ Reproducir';
    });
  }

  audios.forEach((audio) => {
    audio.addEventListener('play', () => {
      audios.forEach((other) => {
        if (other !== audio) other.pause();
      });
      updateIndicators();
    });
    audio.addEventListener('pause', updateIndicators);
    audio.addEventListener('ended', updateIndicators);
  });

  document.querySelectorAll('.play-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const audio = document.getElementById(button.dataset.audioTarget);
      if (!audio) return;
      if (audio.paused) {
        audio.play();
      } else {
        audio.pause();
      }
    });
  });

  // ─── Centro de control: aprobar/rechazar + polling de estado ────────────────
  const elapsedEl = document.getElementById('elapsed-min');
  const timerEl = document.getElementById('session-timer');
  const idleEl = document.getElementById('decision-idle');
  const busyEl = document.getElementById('decision-busy');
  const busyVersionEl = document.getElementById('busy-version');
  const doneEl = document.getElementById('decision-done');
  const approveButtons = Array.from(document.querySelectorAll('[data-approve-version]'));
  const rejectBtn = document.getElementById('reject-btn');

  function lockButtons() {
    approveButtons.forEach((b) => { b.disabled = true; });
    if (rejectBtn) rejectBtn.disabled = true;
  }

  function renderStatus(status) {
    if (elapsedEl) {
      elapsedEl.textContent = status.elapsedMin === null ? '?' : status.elapsedMin;
    }
    if (timerEl) {
      timerEl.classList.remove('timer-warning', 'timer-urgent');
      if (status.elapsedMin !== null) {
        if (status.elapsedMin >= status.sessionLimitMin - 3) timerEl.classList.add('timer-urgent');
        else if (status.elapsedMin >= status.sessionLimitMin - 10) timerEl.classList.add('timer-warning');
      }
    }

    if (status.status === 'pending') return; // estado inicial, nada que cambiar

    lockButtons();
    idleEl.style.display = 'none';

    if (status.status === 'uploading') {
      busyEl.style.display = 'block';
      doneEl.style.display = 'none';
      if (busyVersionEl) busyVersionEl.textContent = status.version || '';
    } else if (status.status === 'uploaded') {
      busyEl.style.display = 'none';
      doneEl.style.display = 'block';
      doneEl.className = 'decision-done decision-ok';
      doneEl.textContent = `✅ Versión ${status.version} subida al Flow. Ya podés cerrar esta pestaña — hacé Submit to QA cuando estés conforme.`;
    } else if (status.status === 'upload-failed') {
      busyEl.style.display = 'none';
      doneEl.style.display = 'block';
      doneEl.className = 'decision-done decision-error';
      doneEl.textContent = `⚠️ Falló la subida de la Versión ${status.version}: ${status.error || 'error desconocido'}. Subí manualmente con upload-to-flow.js.`;
    } else if (status.status === 'rejected') {
      busyEl.style.display = 'none';
      doneEl.style.display = 'block';
      doneEl.className = 'decision-done';
      doneEl.textContent = '✋ Elegiste no subir ninguna versión. Podés subir una manualmente con upload-to-flow.js.';
    }
  }

  async function pollStatus() {
    try {
      const res = await fetch('/status');
      if (!res.ok) return;
      renderStatus(await res.json());
    } catch {
      // red caída momentáneamente — el próximo poll reintenta, no hace falta avisar
    }
  }

  approveButtons.forEach((button) => {
    button.addEventListener('click', async () => {
      const version = button.dataset.approveVersion;
      lockButtons();
      busyEl.style.display = 'block';
      idleEl.style.display = 'none';
      if (busyVersionEl) busyVersionEl.textContent = version;
      try {
        const res = await fetch('/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          alert(`No se pudo aprobar: ${body.error || res.statusText}`);
        }
      } catch (e) {
        alert(`No se pudo contactar al dashboard: ${e.message}`);
      }
    });
  });

  if (rejectBtn) {
    rejectBtn.addEventListener('click', async () => {
      if (!confirm('¿Seguro que no querés subir ninguna versión ahora?')) return;
      lockButtons();
      try {
        const res = await fetch('/reject', { method: 'POST' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          alert(`No se pudo rechazar: ${body.error || res.statusText}`);
        }
      } catch (e) {
        alert(`No se pudo contactar al dashboard: ${e.message}`);
      }
    });
  }

  pollStatus();
  setInterval(pollStatus, 2000);
});
