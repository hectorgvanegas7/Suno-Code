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

// ─── Canal de RESPUESTAS remoto (2026-07-14) ─────────────────────────────────
// Hasta ahora ntfy era estrictamente saliente: toda pausa del pipeline solo se
// resolvía con un ENTER físico en la terminal (o el timeout de 20 min en
// --loop, abandonando la canción). Este canal cierra el lazo desde el celular:
//
//   1. La pausa genera un requestId (nonce de 4 bytes hex).
//   2. La notificación lleva BOTONES (campo `actions` de la API JSON de ntfy):
//      cada botón hace un POST de "<requestId>:<verbo>" al tópico de
//      respuestas DIRECTO desde la app del celular — sin abrir nada.
//   3. El pipeline pollea el tópico de respuestas (GET .../json?poll=1&since=)
//      y solo acepta mensajes cuyo requestId coincida con la pausa vigente.
//
// Seguridad (mismo modelo que TOPIC): tópico impredecible con sufijo aleatorio
// + nonce por pausa (un replay viejo o un mensaje ajeno no matchea) + `since`
// acotado al inicio de la pausa. Si algún día hace falta más, el formato
// admite agregar un HMAC como tercer campo sin romper el parser.
//
// ⚠️ Tópico separado del principal a propósito: publicar la respuesta en el
// mismo tópico generaría una notificación-eco en el celular por cada botón
// tocado. Si se cambia, re-configurar los botones no hace falta (van con URL
// completa en cada notificación) pero sí anotar el cambio acá.
const REPLY_TOPIC = 'cancioneterna-replies-aa938a7e';

// Parser puro (test/ntfy.test.js): "<requestId>:<verbo>" → 'ok' | 'abort' |
// null (mensaje ajeno, requestId viejo, o verbo desconocido).
function parseReply(rawMessage, requestId) {
  const m = /^([0-9a-f]+):(ok|abort)$/.exec(String(rawMessage || '').trim());
  if (!m || m[1] !== requestId) return null;
  return m[2];
}

// Payload con botones de respuesta — extiende buildNtfyPayload. `verbs` es un
// array de { verb: 'ok'|'abort', label } (default Continuar/Abortar).
function buildReplyActionsPayload(body, { requestId, verbs = null, ...opts } = {}) {
  const payload = buildNtfyPayload(body, opts);
  const effectiveVerbs = verbs || [
    { verb: 'ok', label: '✅ Continuar' },
    { verb: 'abort', label: '🛑 Abortar' },
  ];
  payload.actions = effectiveVerbs.map(({ verb, label, body }) => ({
    action: 'http',
    label,
    url: `https://ntfy.sh/${REPLY_TOPIC}`,
    method: 'POST',
    // body explícito para mensajes que no son respuestas de pausa (ej. los
    // veredictos de calibración "fact:<songId>:<tp|fp>" que junta el
    // watchdog); default: el formato de pausa "<requestId>:<verbo>".
    body: body || `${requestId}:${verb}`,
    clear: true,
  }));
  return payload;
}

async function notifyWithReplyActions(body, options = {}) {
  try {
    await fetch('https://ntfy.sh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildReplyActionsPayload(body, options)),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    try { console.warn(`(ntfy con botones no se pudo enviar: ${String(e && e.message).slice(0, 100)})`); } catch {}
  }
}

// Espera una respuesta remota para `requestId`. Resuelve con 'ok' | 'abort' |
// null (timeout o abort de la señal). Poll corto cada pollIntervalMs (más
// robusto en Windows/red doméstica que un long-poll abierto 20 min). Nunca
// lanza — la pausa siempre tiene el ENTER local y el timeout como respaldo.
async function waitForNtfyReply({ requestId, sinceEpochS, timeoutMs = null, pollIntervalMs = 15000, abortSignal = null, fetchImpl = fetch } = {}) {
  const deadline = timeoutMs ? Date.now() + timeoutMs : null;
  const since = sinceEpochS || Math.floor(Date.now() / 1000);
  while (!(abortSignal && abortSignal.aborted) && (!deadline || Date.now() < deadline)) {
    try {
      const res = await fetchImpl(`https://ntfy.sh/${REPLY_TOPIC}/json?poll=1&since=${since}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const text = await res.text();
        for (const line of String(text).split('\n')) {
          if (!line.trim()) continue;
          let evt;
          try { evt = JSON.parse(line); } catch { continue; }
          if (evt.event && evt.event !== 'message') continue;
          const verb = parseReply(evt.message, requestId);
          if (verb) return verb;
        }
      }
    } catch {
      // red caída / timeout del poll — reintentar hasta el deadline
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return null;
}

// Manda un archivo (screenshot) como attachment. La API JSON no acepta
// binarios: es un PUT con el archivo como body y el filename en el header
// `Filename` — que como header HTTP DEBE ser ASCII puro (mismo bug de
// ByteString documentado arriba: un emoji acá tiraría TypeError antes de
// tocar la red). Falla suave, nunca frena el pipeline.
async function notifyAttachment(filePath, { title = 'Screenshot' } = {}) {
  try {
    const fs = require('fs');
    const path = require('path');
    const data = fs.readFileSync(filePath);
    const asciiName = path.basename(filePath).replace(/[^\x20-\x7E]/g, '_');
    await fetch(`https://ntfy.sh/${TOPIC}`, {
      method: 'PUT',
      headers: {
        'Filename': asciiName,
        'X-Title': String(title).replace(/[^\x20-\x7E]/g, '_'),
      },
      body: data,
      signal: AbortSignal.timeout(20000), // un PNG puede pesar >1MB — más margen que el notify de texto
    });
  } catch (e) {
    try { console.warn(`(ntfy attachment no se pudo enviar: ${String(e && e.message).slice(0, 100)})`); } catch {}
  }
}

// Nonce por pausa — corto (8 hex) porque el tópico ya es impredecible.
function newRequestId() {
  return require('crypto').randomBytes(4).toString('hex');
}

module.exports = {
  notify, buildNtfyPayload, PRIORITY_MAP, TOPIC,
  REPLY_TOPIC, parseReply, buildReplyActionsPayload, notifyWithReplyActions,
  waitForNtfyReply, notifyAttachment, newRequestId,
};
