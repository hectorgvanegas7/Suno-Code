# Banco de casos dorados

Casos reales etiquetados para medir las capas de fidelidad con
`node guardia-benchmark.js` (ver CLAUDE.md). Cada carpeta:

- `song.txt` — la letra real (formato song.txt)
- `survey.txt` — la encuesta real de ese pedido
- `expect.json` — `{ descripcion, letraEsBuena, hechosInventadosEsperados }`

⚠️ `song.txt`/`survey.txt` están **gitignorados a propósito en todo el repo**
(datos de clientes — política de privacidad del repo): los casos viven SOLO
en esta máquina. Si se pierde el disco, se pierden los casos — los
`expect.json` commiteados documentan qué existía. Cada incidente real nuevo
debe agregar su carpeta acá (es parte del cierre del incidente, igual que la
entrada de LESSONS.md).
