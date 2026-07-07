const fs = require('fs');
const path = require('path');

const PENDING_FILE = path.join(__dirname, '..', 'pending-gallery-uploads.jsonl');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Hace POST a la URL del Web App. Reintenta hasta 3 veces con backoff (1s, 3s, 8s)
// SOLO si falla la red o hay timeout. Si el Web App responde con error de negocio, no reintenta.
async function _postImageWithRetries({ tabName, fileId, fila, secret, url }, attempt = 1) {
  const backoffs = [1000, 3000, 8000];

  // La columna (H/L/P, escalonado) la decide el Apps Script con su propio
  // contador persistente (PropertiesService) — nunca acá. Calcularla a partir
  // de `fila` reintroduciría el bug que ya evitamos: dos filas separadas por
  // saltos no consecutivos pueden caer en la misma columna y taparse.
  const payload = { secret, tabName, fileId, fila };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Error HTTP: ${response.status}`);
    }

    const result = await response.json();
    if (result.error) {
      // Error de negocio (ej. "Hoja no encontrada"), NO reintentar
      throw new Error(`Error de negocio: ${result.error}`);
    }

    return true;
  } catch (err) {
    const isNetworkOrTimeout = err.name === 'AbortError' || err.message.includes('fetch failed') || err.message.includes('Error HTTP');
    if (isNetworkOrTimeout && attempt <= backoffs.length) {
      const waitMs = backoffs[attempt - 1];
      console.log(`  [Gallery] Fallo de red/timeout (${err.message}). Reintentando en ${waitMs}ms... (Intento ${attempt}/${backoffs.length})`);
      await sleep(waitMs);
      return _postImageWithRetries({ tabName, fileId, fila, secret, url }, attempt + 1);
    }
    // Si no es error de red, o si agotamos los reintentos, propagamos el error
    throw err;
  }
}

// Función principal de envío. No lanza excepciones hacia arriba si los 3 intentos fallan.
async function postImageToGallery({ tabName, fileId, fila, secret, url }) {
  if (!url) {
    console.log('⚠️ No hay GALLERY_WEBAPP_URL configurada. Ignorando subida a galería.');
    return;
  }

  try {
    await _postImageWithRetries({ tabName, fileId, fila, secret, url });
    console.log(`✅ Screenshot enviado a la galería (Fila ${fila}) exitosamente.`);
    return true;
  } catch (err) {
    console.log(`⚠️ postImageToGallery falló tras agotar reintentos o por error de negocio: ${err.message}`);
    
    // Si es error de red o timeout final, encolar
    if (err.name === 'AbortError' || err.message.includes('fetch failed') || err.message.includes('Error HTTP')) {
      console.log(`  📝 Guardando en pending-gallery-uploads.jsonl para reintentar en el próximo arranque.`);
      const entry = { tabName, fileId, fila, timestamp: Date.now() };
      fs.appendFileSync(PENDING_FILE, JSON.stringify(entry) + '\n');
    }
    return false;
  }
}

async function flushPendingGalleryUploads({ secret, url }) {
  const claimedFile = PENDING_FILE + '.processing';

  // Restos de un flush anterior que se cortó a mitad (crash/cierre abrupto):
  // sin esto quedarían huérfanos en `.processing` para siempre, porque ya no
  // viven en PENDING_FILE. Los reincorporamos antes de seguir.
  if (fs.existsSync(claimedFile)) {
    fs.appendFileSync(PENDING_FILE, fs.readFileSync(claimedFile, 'utf-8'));
    fs.unlinkSync(claimedFile);
  }

  if (!fs.existsSync(PENDING_FILE) || !url) return;

  // Reclamar el archivo YA (rename atómico) antes de procesar, no después:
  // así cualquier entrada nueva que se agregue mientras este flush corre
  // (otra corrida en paralelo, o un fallo de postImageToGallery durante este
  // mismo flush) cae en un PENDING_FILE fresco en vez de perderse cuando
  // reescribamos el archivo al final.
  fs.renameSync(PENDING_FILE, claimedFile);
  const lines = fs.readFileSync(claimedFile, 'utf-8').split('\n').filter(Boolean);

  if (lines.length === 0) {
    fs.unlinkSync(claimedFile);
    return;
  }

  console.log(`\n🔄 Procesando ${lines.length} envíos pendientes a la galería...`);
  const stillPending = [];

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (e) {
      continue;
    }

    try {
      console.log(`  -> Reintentando envío de fila ${entry.fila}...`);
      await _postImageWithRetries({
        tabName: entry.tabName,
        fileId: entry.fileId,
        fila: entry.fila,
        secret,
        url
      });
      console.log(`  ✅ Envío pendiente (fila ${entry.fila}) completado.`);
    } catch (err) {
      console.log(`  ⚠️ Envío pendiente (fila ${entry.fila}) volvió a fallar (${err.message}). Queda en cola.`);
      stillPending.push(line);
    }
  }

  fs.unlinkSync(claimedFile);
  if (stillPending.length > 0) {
    fs.appendFileSync(PENDING_FILE, stillPending.join('\n') + '\n');
  }
  if (!fs.existsSync(PENDING_FILE)) {
    console.log(`✅ Cola de envíos pendientes vaciada.`);
  }
}

module.exports = { postImageToGallery, flushPendingGalleryUploads };
