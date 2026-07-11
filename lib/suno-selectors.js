// lib/suno-selectors.js — Selectores de la UI de Suno compartidos entre
// suno-fill.js, lib/suno-create-dl.js y start-flow.js.
//
// Antes vivían duplicados literal en cada archivo (ej. el mismo
// `[data-testid="lyrics-textarea"]` copiado 5 veces). Si Suno cambia un
// selector, esto evita el mismo tipo de divergencia que ya pasó con la lógica
// de "Enter Flow + Assign" (ver LESSONS.md, ahora centralizada en
// lib/flow-helpers.js) — un solo lugar para actualizar, no N copias que
// puedan quedar desincronizadas.
//
// Solo strings — sin lógica ni comportamiento. Mover algo de acá a otro lugar
// no cambia qué hace el pipeline, solo dónde vive el string.

module.exports = {
  LYRICS_TEXTAREA: '[aria-label="Lyrics editor"], [data-testid="lyrics-textarea"], .lyrics-editor-content',
  TITLE_INPUT: 'input[placeholder*="Title" i], input[name*="title" i], [data-testid*="title" i] input',
  EXPAND_LYRICS_BOX_LABEL: 'Expand lyrics box',
  // Suno rediseñó el placeholder de ejemplo (2026-07): antes tenía la palabra
  // "style" literal, ahora es un ejemplo rotativo de géneros ("concertina,
  // cafe music, british invasion..." — sin la palabra "style" en ningún
  // lado), así que el matching por placeholder dejó de funcionar por
  // completo (confirmado con el detector de drift, 2026-07-04). El wrapper
  // con data-testid="create-form-styles-wrapper" es estable y contiene
  // exactamente 1 textarea — anclado a eso en vez de a un placeholder que
  // puede volver a cambiar con cualquier rotación de ejemplos.
  STYLE_TEXTAREA: '[data-testid="create-form-styles-wrapper"] textarea',
  MORE_OPTIONS_TOGGLE_TEXT: 'More Options',
  WEIRDNESS_SLIDER_LABEL: 'Weirdness',
  STYLE_INFLUENCE_SLIDER_LABEL: 'Style Influence',
  CREATE_SONG_ROLE_NAME: 'Create song',
  CREATE_SONG_ARIA_SELECTOR: 'button[aria-label="Create song"]',
  // El aria-label real del botón "⋯" por card SIGUE siendo "More options"
  // (15/15 clip-rows). El "fix" de la madrugada del 2026-07-09 que apuntaba
  // esto a "More from Suno" estaba mal diagnosticado — ese label pertenece a
  // un único botón no relacionado fuera de las cards, confirmado en vivo con
  // suno-selector-drift.js + probe directo por CDP la tarde del mismo día
  // (ver LESSONS.md). Si vuelve a fallar el click de Download con "no-menu",
  // re-verificar en vivo antes de tocar este selector — no confiar a ciegas
  // en ningún aria-label sin comprobarlo contra el DOM real.
  MORE_OPTIONS_MENU_ARIA_SELECTOR: '[aria-label="More options"]',
  CLIP_ROW: '[data-testid="clip-row"]',
};
