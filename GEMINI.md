# Canción Eterna — Pipeline de producción de canciones

**La documentación canónica y actualizada del proyecto vive en `CLAUDE.md`.
Leé ese archivo — este es solo un puntero.**

Este archivo era una copia vieja del flujo manual (Create a mano, registro en
la hoja con `node sheets.js` suelto, tiempo siempre manual) y quedó obsoleto
cuando el pipeline pasó a ser 100% automatizado con `start-flow.js` como
orquestador único. Para no mantener dos documentos que se desincronizan, todo
el contenido se consolidó en `CLAUDE.md`:

- Submit to QA es ahora AUTOMÁTICO (con un temporizador anti-bot aleatorio entre 26-31 mins).
- Flujo completo en orden, con la única interacción manual (revisar la letra).
- Archivos clave y flags de `start-flow.js`.
- Estructura de letra que valida `lib/song-validate.js`.
- `LESSONS.md` — log de bugs reales ya arreglados (leerlo antes de debuggear).
