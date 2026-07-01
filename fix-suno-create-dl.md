# Fix definitivo de lib/suno-create-dl.js — 4 bugs con causa raíz identificada

Analicé el código completo. Los 4 problemas (Create no se clickea, descarga la
canción equivocada, no espera la generación, nombra mal el archivo) tienen UNA
raíz común: el código identifica las canciones por POSICIÓN en la lista (cardIndex
0, 1) y cuenta elementos `<audio>` GLOBALMENTE en el DOM. Pero Suno mantiene las
canciones viejas en la lista CON su audio ya cargado, así que:
- La cuenta de `<audio>` ya da >= 2 por las canciones viejas → el código cree que
  la generación terminó cuando en realidad ni empezó.
- Las "primeras 2 cards" son las viejas (El Matador, etc.), no la nueva que aún
  está generando con spinner → descarga la equivocada.
- El nombre del archivo se arma con el título de song.txt aunque el audio
  descargado sea de otra canción.

LA SOLUCIÓN es anclar TODO al título de la canción actual, no a la posición.

Antes de codear: leé CLAUDE.md y LESSONS.md. Inspeccioná el DOM real de Suno para
confirmar los selectores (las cards, el título dentro de cada card, el indicador
de spinner/loading). Documentá los fixes en LESSONS.md.

---

## FIX 1 — Identificar la card por TÍTULO, no por índice

En `lib/suno-create-dl.js`, reemplazá toda la lógica basada en `cardIndex` por
lógica basada en el título. Necesitás:

1. Una función que, dado el título de la canción actual (que ya viene de
   `verifyFormBeforeCreate` → `verify.titulo`), encuentre las cards de la lista
   de la derecha cuyo título visible coincida con ese título (normalizado:
   minúsculas, sin tildes, sin puntuación — reusá la función `normalize` de
   `lib/audio-match.js`).
2. Cada canción genera 2 cards con el MISMO título. Esas 2 cards (y solo esas)
   son las que hay que descargar. Ignorá cualquier card con otro título.
3. El botón `⋯` a clickear debe ser el `⋯` DE ESA card específica (buscar el
   botón More options que sea descendiente/hermano del contenedor de la card que
   tiene el título correcto), NO el enésimo `⋯` de toda la página.

Inspeccioná el DOM para ver cómo está estructurada cada card (probablemente un
contenedor con el título como texto y el botón ⋯ dentro). Usá esa relación
padre-hijo para asociar título → botón ⋯ correcto.

## FIX 2 — Esperar la generación contando SOLO cards del título actual, sin spinner

Reescribí `waitForBothSongs`. En vez de contar `<audio>` global:
1. Contá cuántas cards con el título actual existen (deben aparecer 2 tras Create).
2. Para cada una, verificá que YA NO tenga el indicador de "generando" (el spinner
   circular que se ve en las capturas — inspeccioná el DOM para el selector real:
   puede ser un elemento con role="progressbar", una clase de loading, o un
   spinner SVG animado). Una card está lista cuando tiene su título Y no tiene
   spinner Y tiene duración visible (ej. "3:18").
3. La condición de "generación completa" = 2 cards con el título actual, ambas sin
   spinner. Recién ahí procedé a descargar.
4. Mantené el timeout de 8 minutos con polling. Si a los 8 min solo hay 1 card
   lista, seguí con 1 (como ya hace), pero SIEMPRE del título correcto.

Esto arregla de raíz el "no esperó a que se genere": la señal ahora es específica
de la canción actual, no contaminada por las canciones viejas.

## FIX 3 — Botón Create: apuntar al botón correcto y confirmar que se disparó

El `getByRole('button', { name: /create/i }).first()` puede estar agarrando un
elemento equivocado (en Suno hay una card "Create a song using your voice" y un
item de menú lateral "Create"). 
1. Apuntá específicamente al botón Create grande del formulario (el naranja).
   Inspeccioná el DOM: probablemente sea un button dentro del panel de la
   izquierda, cerca del textarea de Lyrics, con texto exactamente "Create".
   Usá un selector más específico (por contenedor del formulario + texto exacto,
   o por una clase/posición estable), no el primer match de toda la página.
2. Después de clickear Create, CONFIRMÁ que la generación arrancó: esperá a que
   aparezca una card NUEVA con el título actual y con spinner activo (señal de que
   Suno empezó a generar). Si tras el click no aparece ninguna card nueva
   generándose en ~10s, el click no funcionó → reintentá (safeClick + jsClick),
   y si aún así no, avisá claro para click manual.
3. NO cuentes con que ya se generó por el simple hecho de que hay audios en el DOM.

## FIX 4 — Nombre del archivo derivado del título verificado (queda bien solo)

Una vez que FIX 1–3 estén, el nombre ya sale correcto porque descargás la card
del título correcto. Mantené el `slug` del título verificado. Como salvaguarda
extra: después de descargar, si podés leer el título real de la card que
descargaste, verificá que coincida con el slug usado; si no coincide, renombrá o
avisá. Nunca guardes un audio con el nombre de otra canción.

---

## Salvaguardas que NO cambian
- NUNCA hacer Submit to QA (regla dura existente).
- Si algo falla, caer a manual limpio con mensaje claro de QUÉ card/título esperaba
  y qué encontró — no descargar a ciegas la primera card disponible.
- No romper el resto del pipeline. No reintroducir networkidle
  (`grep -rn networkidle .` debe seguir en cero).
- Screenshots diagnósticos antes de cada acción crítica (ya existen, mantenelos).

## Criterio de aceptación
- Con canciones viejas presentes en la lista de Suno, el script SOLO descarga las
  2 cards cuyo título coincide con la canción actual de song.txt.
- El script espera de verdad a que la canción actual termine de generar (spinner
  desaparecido), sin confundirse con audios viejos.
- El botón Create se clickea solo de forma confiable, y el script confirma que la
  generación arrancó antes de seguir.
- El archivo descargado tiene el nombre del título correcto Y su audio corresponde
  a ese título.
- Si el título de la card no matchea, el script FRENA y avisa, nunca descarga otra
  canción.
