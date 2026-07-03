// lib/ntfy.js — Notificaciones push vía ntfy.sh
// Falla silenciosamente — nunca debe romper el pipeline.
//
// ⚠️ Tópico privado con sufijo aleatorio (ntfy.sh no tiene auth: cualquiera
// que adivine/conozca el nombre del tópico puede leer las notificaciones o
// mandar las suyas). El tópico viejo "cancioneterna-gabo-2026" era
// adivinable (nombre del negocio + año). Si este tópico se vuelve a cambiar,
// Hector tiene que re-suscribirse en la app de ntfy — avisar explícitamente.
const TOPIC = 'cancioneterna-flow-cd5566fa';

async function notify(body, { title = 'Canción Eterna', priority = 'default', tags = 'musical_note' } = {}) {
  try {
    await fetch(`https://ntfy.sh/${TOPIC}`, {
      method: 'POST',
      headers: { Title: title, Priority: priority, Tags: tags },
      body,
      // Sin timeout, un ntfy.sh caído que acepta el TCP pero nunca responde
      // dejaría el pipeline colgado en un await notify() — 8s y se suelta.
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // Silencioso — red sin internet o ntfy caído no deben frenar el pipeline
  }
}

module.exports = { notify };
