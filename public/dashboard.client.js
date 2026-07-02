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
});
