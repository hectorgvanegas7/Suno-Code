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
  TITLE_INPUT: 'input[placeholder="Song Title (Optional)"]',
  EXPAND_LYRICS_BOX_LABEL: 'Expand lyrics box',
  STYLE_TEXTAREA: 'textarea[placeholder*="style" i], textarea[aria-label*="style" i], textarea[placeholder*="estilo" i]',
  MORE_OPTIONS_TOGGLE_TEXT: 'More Options',
  WEIRDNESS_SLIDER_LABEL: 'Weirdness',
  STYLE_INFLUENCE_SLIDER_LABEL: 'Style Influence',
  CREATE_SONG_ROLE_NAME: 'Create song',
  CREATE_SONG_ARIA_SELECTOR: 'button[aria-label="Create song"]',
  MORE_OPTIONS_MENU_ARIA_SELECTOR: '[aria-label="More options"]',
  CLIP_ROW: '[data-testid="clip-row"]',
};
