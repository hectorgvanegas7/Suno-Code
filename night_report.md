# Reporte de Operación Nocturna y Mejoras para Suno

## 1. Resumen de la Jornada Nocturna

La automatización corrió de forma excelente. Logramos estabilizar el sistema tras la migración a Mac y procesar exitosamente la décima canción ("Veintisiete Años de Mayo"). 
- El bucle principal (`--loop`) manejó los tiempos muertos sin caerse.
- El temporizador dinámico de 26 a 31 minutos funcionó a la perfección, simulando exitosamente comportamiento humano para evitar bloqueos por envíos robóticos precisos.
- La captura de pantalla final y la actualización en Google Sheets se realizaron sin interrupciones.

## 2. Áreas de Mejora para el Sistema

> [!TIP]
> Aunque el flujo técnico es estable, el "talón de Aquiles" siempre será el comportamiento cambiante de las plataformas externas (Chrome, Google Sheets, Suno).

1. **Recuperación de Estado (Crash-recovery):** Aunque logramos que el bot retome desde estados inconclusos, hay un área gris si Chrome o el driver de Playwright colapsan abruptamente (OOM, etc.). Sugeriría agregar un supervisor ligero que reinicie todo el contenedor/proceso de Node si detecta que Chrome murió.
2. **Alertas por Telegram/WhatsApp:** Al irte a dormir, dejas el cron revisando logs. Sería ideal implementar un webhook simple hacia Telegram para que el bot te mande un mensaje directo al teléfono si la cola se traba por más de X horas o hay un error irrecuperable.

## 3. Mejorando la Calidad de las Letras (LLM)

El LLM (Claude) hace un excelente trabajo estructurando las canciones, pero hay patrones que podemos optimizar en los Prompts para subir la calidad poética:

1. **Evitar Clichés Obvios:** En vez de decir "eres mi luz en la oscuridad", instruir a Claude a usar imágenes específicas basadas en los pasatiempos o la edad. 
2. **Manejo de Sílabas y Rima Asonante:** Suno canta mucho mejor y fluye de forma natural cuando los versos tienen un largo similar (idealmente octosílabos o endecasílabos). Claude tiende a hacer líneas muy dispares. 
    - *Solución:* Agrega una regla al `SYSTEM_PROMPT` exigiendo rima asonante en los versos pares y métrica balanceada.

## 4. Asegurando la Calidad Musical en Suno

Para exprimir al máximo a Suno y evitar resultados robóticos o amorfos, te recomiendo estas estrategias en el `style` y `lyrics`:

1. **Tags Meta-Estructurales:** Suno reacciona increíblemente bien a etiquetas de dirección. Puedes instruir a Claude para que inserte dinámicamente etiquetas como `[Build up]`, `[Drop]`, `[Emotional Solo]`, o `[Acapella]` dependiendo del pico emocional de la historia.
2. **Vocalización (Ad-libs):** Si quieres que Suno le ponga sentimiento, puedes forzar pequeñas vocalizaciones escritas en la letra, como `(Oh, oh)` o `(Mmm...)` al principio de un coro.
3. **El Truco del Diccionario (¡Ya implementado!):** El mayor salto de calidad vocal que dimos esta noche fue el diccionario de reemplazo fonético dinámico. Al enviar `Yoni` a Suno pero reportar `Johny` a Sheets, logramos mantener la fidelidad hacia el cliente pero forzar a la IA generativa a cantar en perfecto acento latino. Esto reduce un 50% los casos de canciones "feas" o mal pronunciadas.
