# Canción Eterna — Pipeline de producción de canciones

**La documentación canónica y actualizada del proyecto vive en `CLAUDE.md`.
Leé ese archivo — este es solo un puntero.**

Este archivo era una copia vieja del flujo manual (Create a mano, registro en
la hoja con `node sheets.js` suelto, tiempo siempre manual) y quedó obsoleto
cuando el pipeline pasó a ser 100% automatizado con `start-flow.js` como
orquestador único. Para no mantener dos documentos que se desincronizan, todo
el contenido se consolidó en `CLAUDE.md`:

- Regla Dura #1 (NUNCA Submit to QA automático) — no negociable.
- Flujo completo en orden, con la única interacción manual (el Submit).
- Archivos clave y flags de `start-flow.js`.
- Estructura de letra que valida `lib/song-validate.js`.
- `LESSONS.md` — log de bugs reales ya arreglados (leerlo antes de debuggear).
