// lib/http-retry.js — clasificación compartida de errores HTTP: ¿reintentar
// tiene sentido, o es un error que reintentar nunca arregla?
//
// 4xx (API key inválida, request malformado, sin crédito) son errores de
// configuración — reintentar nunca los arregla. 429 (rate limit) y 5xx/red sí
// son transitorios. Antes esta regla vivía duplicada, copiada literal, en
// lib/llm-provider.js (x2) y lib/song-corrector.js — un cambio en una copia
// no se propagaba a la otra (mismo patrón de bug que "Enter Flow + Assign",
// ver LESSONS.md: cualquier lógica duplicada en más de un archivo es una
// fuente conocida de bugs en este repo).

function isRetryableHttpStatus(status) {
  if (status >= 400 && status < 500 && status !== 429) return false;
  return true;
}

module.exports = { isRetryableHttpStatus };
