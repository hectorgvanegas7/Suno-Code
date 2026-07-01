// lib/ntfy.js — Notificaciones push vía ntfy.sh
// Tópico: cancioneterna-gabo-2026 (mismo que usa el modo --poll)
// Falla silenciosamente — nunca debe romper el pipeline.

const TOPIC = 'cancioneterna-gabo-2026';

async function notify(body, { title = 'Canción Eterna', priority = 'default', tags = 'musical_note' } = {}) {
  try {
    await fetch(`https://ntfy.sh/${TOPIC}`, {
      method: 'POST',
      headers: { Title: title, Priority: priority, Tags: tags },
      body,
    });
  } catch {
    // Silencioso — red sin internet o ntfy caído no deben frenar el pipeline
  }
}

module.exports = { notify };
