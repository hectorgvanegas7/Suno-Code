// setup-whisper.js — Verifica e instala las dependencias de análisis de audio:
// faster-whisper (Python), ffmpeg, Python mismo.
// Correr una sola vez: node setup-whisper.js
// También crea Downloads/suno/ si no existe.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { SUNO_DIR } = require('./lib/audio-match');

function check(label, fn) {
  try {
    const ok = fn();
    console.log(`  ✅ ${label}${ok ? ': ' + ok : ''}`);
    return true;
  } catch (e) {
    console.log(`  ❌ ${label}: ${e.message || e}`);
    return false;
  }
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 30000, ...opts });
  if (result.status !== 0 || result.error) {
    throw new Error(result.stderr?.trim() || result.error?.message || `exit ${result.status}`);
  }
  return (result.stdout || '').trim();
}

console.log('\n=== setup-whisper.js: verificando dependencias de análisis de audio ===\n');

// 1. Carpeta Downloads/suno/
console.log('1. Carpeta Downloads/suno/');
try {
  fs.mkdirSync(SUNO_DIR, { recursive: true });
  console.log(`  ✅ ${SUNO_DIR}`);
} catch (e) {
  console.log(`  ❌ No se pudo crear ${SUNO_DIR}: ${e.message}`);
}

// 2. Python
console.log('\n2. Python');
let pythonCmd = null;
for (const cmd of ['python', 'python3']) {
  try {
    const ver = run(cmd, ['--version']);
    console.log(`  ✅ ${cmd}: ${ver}`);
    pythonCmd = cmd;
    break;
  } catch {
    console.log(`  ✗ ${cmd} no encontrado`);
  }
}
if (!pythonCmd) {
  console.log('\n  ⚠️  Python no está instalado o no está en PATH.');
  console.log('  Instalalo desde https://www.python.org/downloads/ (marcá "Add to PATH").');
  console.log('  O con winget: winget install Python.Python.3.12');
}

// 3. faster-whisper
console.log('\n3. faster-whisper');
if (pythonCmd) {
  let hasFW = false;
  try {
    run(pythonCmd, ['-c', 'import faster_whisper; print(faster_whisper.__version__)']);
    const ver = spawnSync(pythonCmd, ['-c', 'import faster_whisper; print(faster_whisper.__version__)'], { encoding: 'utf-8', timeout: 10000 });
    console.log(`  ✅ faster-whisper ${(ver.stdout || '').trim()}`);
    hasFW = true;
  } catch {
    console.log('  ✗ faster-whisper no instalado. Intentando instalar...');
    try {
      const install = spawnSync(pythonCmd, ['-m', 'pip', 'install', 'faster-whisper'], {
        encoding: 'utf-8', timeout: 120000, stdio: 'pipe',
      });
      if (install.status === 0) {
        console.log('  ✅ faster-whisper instalado correctamente.');
        hasFW = true;
      } else {
        console.log(`  ❌ Instalación fallida: ${(install.stderr || '').substring(0, 200)}`);
        console.log('  Intentalo manualmente: pip install faster-whisper');
        console.log('  Si hay problema de permisos: pip install --user faster-whisper');
      }
    } catch (e) {
      console.log(`  ❌ Error al instalar: ${e.message}`);
    }
  }

  // Pre-descargar el modelo small si faster-whisper está disponible
  if (hasFW) {
    console.log('\n  Verificando modelo "small" (puede tardar unos minutos si no está cacheado)...');
    try {
      const testScript = `
from faster_whisper import WhisperModel
import sys
m = WhisperModel("small", device="cpu", compute_type="int8")
print("ok")
`;
      const result = spawnSync(pythonCmd, ['-c', testScript], {
        encoding: 'utf-8', timeout: 5 * 60 * 1000,
      });
      if ((result.stdout || '').includes('ok')) {
        console.log('  ✅ Modelo "small" listo.');
      } else {
        console.log('  ⚠️ El modelo se descargará en la primera transcripción (puede tardar ~5 min).');
      }
    } catch {
      console.log('  ⚠️ No se pudo pre-cargar el modelo. Se descargará en el primer uso.');
    }
  }
} else {
  console.log('  Omitido (Python no disponible)');
}

// 4. ffmpeg / ffprobe
console.log('\n4. ffmpeg / ffprobe');
let hasFFmpeg = false;
try {
  const ver = run('ffprobe', ['-version']);
  const firstLine = ver.split('\n')[0];
  console.log(`  ✅ ffprobe: ${firstLine}`);
  hasFFmpeg = true;
} catch {
  console.log('  ❌ ffprobe no encontrado en PATH.');
  console.log('  Instalalo con winget: winget install Gyan.FFmpeg');
  console.log('  O descargalo de https://ffmpeg.org/download.html y agregá la carpeta bin/ al PATH.');
  console.log('  (Reiniciá la terminal después de instalarlo para que tome el nuevo PATH.)');
}

// Resumen
console.log('\n══════════════════════════════════════════════════════');
const items = [
  pythonCmd ? '✅ Python' : '❌ Python',
  '(faster-whisper se revisó arriba)',
  hasFFmpeg ? '✅ ffmpeg/ffprobe' : '❌ ffmpeg/ffprobe',
];
console.log('Resumen:', items.join(' | '));

if (!pythonCmd || !hasFFmpeg) {
  console.log('\n⚠️  Algunas dependencias faltan. El análisis de audio no estará disponible hasta resolverlas.');
  console.log('   verify-audio.js seguirá funcionando para lo que sí esté disponible (ej. solo duración si ffprobe está).');
} else {
  console.log('\n✅ Todo listo. Podés correr: node verify-audio.js');
}

console.log('══════════════════════════════════════════════════════\n');
