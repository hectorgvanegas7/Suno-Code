// lib/session-time.js — Parsea el texto de duración de sesión que Suno/el
// Flow muestra en "Recent completions" (ej. "26 min session", "1h 5min
// session", "1h session") a { timeHHMM, totalTimeDecimal } para la hoja de
// Google Sheets.
//
// Extraído de start-flow.js (que no es requireable como módulo — corre su
// pipeline entero al cargarse) para poder testear esta lógica pura sin tocar
// Chrome/Suno/Flow. Ver test/session-time.test.js.

// Devuelve { timeHHMM, totalTimeDecimal } o null si el formato no se reconoce.
function parseSessionTime(text) {
  if (!text) return null;
  const hourMin = text.match(/(\d+)\s*h\s*(\d+)\s*min/i);
  if (hourMin) {
    const h = parseInt(hourMin[1], 10);
    const m = parseInt(hourMin[2], 10);
    const totalMin = h * 60 + m;
    return {
      timeHHMM: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
      totalTimeDecimal: Math.round((totalMin / 60) * 100) / 100,
    };
  }
  const minOnly = text.match(/(\d+)\s*min/i);
  if (minOnly) {
    const totalMin = parseInt(minOnly[1], 10);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return {
      timeHHMM: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
      totalTimeDecimal: Math.round((totalMin / 60) * 100) / 100,
    };
  }
  // "1h session" / "2 h session" — horas exactas sin minutos (sin esto, una
  // sesión de exactamente 1 hora tiraría "No se pudo parsear tiempo").
  const hourOnly = text.match(/(\d+)\s*h(?:r|our)?s?\b/i);
  if (hourOnly) {
    const h = parseInt(hourOnly[1], 10);
    return {
      timeHHMM: `${String(h).padStart(2, '0')}:00`,
      totalTimeDecimal: h,
    };
  }
  return null;
}

// Parsea el texto del timer de la página del Flow (ej. "32:21 · 20 min target", "1:12:05 - 20 min target")
// y devuelve los minutos transcurridos en número decimal, o null si no matchea.
function parseWebpageTimer(text) {
  if (!text) return null;
  // Match "HH:MM:SS" or "MM:SS" antes de un guion/punto/separador y "min target"
  const match = text.match(/(?:(\d+):)?(\d+):(\d+)\s*[\u00b7\-\|·]\s*\d+\s*min\s*target/i);
  if (!match) return null;

  const hh = match[1] ? parseInt(match[1], 10) : 0;
  const mm = parseInt(match[2], 10);
  const ss = parseInt(match[3], 10);
  return hh * 60 + mm + ss / 60;
}

module.exports = { parseSessionTime, parseWebpageTimer };
