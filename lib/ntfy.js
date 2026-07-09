// lib/ntfy.js — Notificaciones push vía ntfy.sh
// Falla suave — nunca debe romper el pipeline (pero deja una línea en el log
// si no pudo enviar, ver abajo).
//
// ⚠️ Tópico privado con sufijo aleatorio (ntfy.sh no tiene auth: cualquiera
// que adivine/conozca el nombre del tópico puede leer las notificaciones o
// mandar las suyas). El tópico viejo "cancioneterna-gabo-2026" era
// adivinable (nombre del negocio + año). Si este tópico se vuelve a cambiar,
// Hector tiene que re-suscribirse en la app de ntfy — avisar explícitamente.
//
// 🐛 BUG REAL (auditoría 2026-07-09): la versión anterior mandaba el título
// como header HTTP (`Title:`). fetch() de Node exige headers ByteString
// (Latin-1): cualquier título con un emoji fuera de Latin-1 (🛑 🔄 ⏱️ ⚠️ ✋ 🌙 …)
// tiraba TypeError ANTES de tocar la red, el catch mudo se lo tragaba, y la
// notificación JAMÁS llegaba al celular — justo las más críticas (watchdog,
// circuit breaker, timeout de interacción humana) tenían emoji en el título.
// Ahora se publica con la API JSON de ntfy (POST a la raíz, tópico en el
// body), que soporta UTF-8 completo en título, mensaje y tags.
const TOPIC = 'cancioneterna-flow-cd5566fa';

// La API JSON de ntfy espera priority numérica 1-5.
const PRIORITY_MAP = { min: 1, low: 2, default: 3, high: 4, urgent: 5, max: 5 };

// Construye el payload JSON — extraído de notify() para poder testearlo
// offline (test/ntfy.test.js) sin tocar la red.
function buildNtfyPayload(body, { title = 'Canción Eterna', priority = 'default', tags = 'musical_note', click = null } = {}) {
  const payload = {
    topic: TOPIC,
    message: String(body),
    title: String(title),
    priority: PRIORITY_MAP[priority] || PRIORITY_MAP.default,
    tags: String(tags).split(',').map((t) => t.trim()).filter(Boolean),
  };
  if (click) payload.click = String(click);
  return payload;
}

async function notify(body, options = {}) {
  try {
    await fetch('https://ntfy.sh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildNtfyPayload(body, options)),
      // Sin timeout, un ntfy.sh caído que acepta el TCP pero nunca responde
      // dejaría el pipeline colgado en un await notify() — 8s y se suelta.
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    // Nunca frena el pipeline — pero deja rastro en consola/log unificado.
    // El catch 100% mudo de antes escondió durante días que los títulos con
    // emoji jamás llegaban (ver el bug de arriba).
    try { console.warn(`(ntfy no se pudo enviar: ${String(e && e.message).slice(0, 100)})`); } catch {}
  }
}

module.exports = { notify, buildNtfyPayload, PRIORITY_MAP, TOPIC };
