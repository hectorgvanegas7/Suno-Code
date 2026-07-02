const MOCK_RESPONSE = `**Título:** Cuatro Regalos de Mi Vida

**Voz:** Femenina

**Trato:** Tú

**Estilo Suno:** Balada, tempo moderado, piano suave y cuerdas cálidas, acompañamiento emocional y delicado, voz femenina expresiva y cercana llena de amor y gratitud, sonido íntimo y sentimental, love ballad, emotional, heartfelt, Latin American Spanish, neutral accent, seseo

---

[Verse 1]
Recuerdo el miedo de sentir una vida moviéndose por primera vez,
sin saber si sería suficiente para darte lo que mereces.
Scarlet, llegaste un veinticinco de septiembre del dos mil seis,
y en mis brazos aprendí lo que significa amar sin condición.

[Chorus 1]
Hoy le pido a Dios que cuide cada paso que ustedes dan,
que la vida les regrese en bendiciones lo que un día les di.
Emanuel, llegaste luchando desde el vientre por vivir,
y esa fuerza me enseñó que naciste para nunca rendirte.

[Verse 2]
Un quince de enero llegaste pequeño, rosado y con mucho pelo,
tu carita tierna llenó de ternura toda la casa.
Nestor, viajamos juntos hasta el Ecuador tú y yo,
y tu sonrisa alegre se quedó grabada para siempre en mí.

[Chorus 2]
Estoy orgullosa de cada camino que ustedes han decidido tomar,
de ver cómo cada día se acercan más a lo que Dios les prometió.
Erick, desde la barriga ya dabas guerra por nacer,
y hoy veo en tu alegría la fuerza que te hace un guerrero.

[Bridge]
Perdónenme si alguna vez sintieron que les faltó algo más,
porque les di todo lo que pude con el amor que llevo dentro.
Si un día ya no estoy en este mundo para verlos crecer,
guarden esta canción que escribí con cada latido para ustedes.

[Outro]
Los amo más que a mi propia vida, eso nunca cambiará,
mientras tenga aliento aquí estaré para aplaudir cada logro.
Que Dios los cuide y los bendiga en cada paso que den,
mamá los ama por siempre, eso lo pueden asegurar.

---

**QA Checklist:**
- 6 secciones en orden: ✓
- 4 líneas por sección: ✓
- Nombre = primera palabra Chorus 1 y 2: ✗ (por regla de múltiples destinatarios con 4 nombres, cada nombre se ubica en la línea 3 de su sección correspondiente, no como primera palabra)
- Nombre solo una vez por chorus: ✓
- Nombre ausente en Verse 1: ✗ (por regla de 4 destinatarios, Scarlet debe aparecer en línea 3 del Verse 1)
- Chorus 1 ≠ Chorus 2: ✓
- Verse 2 con escena concreta: ✓
- Bridge con detalle más vulnerable: ✓
- Nada inventado: ✓
- Trato consistente en toda la letra: ✓
- Números, meses y siglas completos: ✓
- Título no cantable: ✓
- Sin guiones largos / punto y coma / dos puntos: ✓
- Sin líneas consecutivas con misma palabra inicial: ✓
- Todas las líneas con sentido lógico: ✓
- Estilo Suno incluye seseo + acento latinoamericano: ✓
- Sin diálogos citados textualmente de la encuesta: ✓
- Destinatarios múltiples balanceados (si aplica): ✓ (cada uno de los cuatro hijos tiene su propio espacio y detalle específico, sin favoritismos)
- POV consistente / voz de Dios si es "para mí": ✓
- Sin acróstico en el nombre: ✓

**Advertencias:** Los dos ítems marcados con ✗ (nombre como primera palabra del coro y ausencia de nombre en Verse 1) son excepciones intencionales y obligatorias por la regla de "Múltiples Destinatarios" para cuatro nombres, donde cada nombre debe aparecer en la línea 3 de su sección designada (Verse 1, Chorus 1, Verse 2, Chorus 2) en lugar de seguir el patrón estándar de un solo destinatario. Esto se hizo específicamente para corregir la ausencia de "Nestor" señalada en la corrección obligatoria del intento anterior. No se usó ninguna re-escritura fonética.`;

async function generate(provider, surveyText, systemPrompt, isDryRun) {
  if (isDryRun) {
    console.log('--- LOCAL OFFLINE MOCK ACTIVE ---');
    console.log('Returning cached/mock song response text without calling any API...');
    return MOCK_RESPONSE;
  }

  if (provider === 'gemini') {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY no está configurada. Corré "setx GEMINI_API_KEY <tu-key>" y abrí una terminal nueva.');
    }
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: systemPrompt,
      generationConfig: {
        maxOutputTokens: 2000,
        temperature: 1.0,
      },
    });
    const result = await model.generateContent(surveyText);
    return result.response.text().trim();
  } else {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY no está configurada. Corré "setx ANTHROPIC_API_KEY <tu-key>" y abrí una terminal nueva.');
    }
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 8192,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
        messages: [{ role: 'user', content: surveyText }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    if (data.usage) {
      const u = data.usage;
      console.log(
        `  usage: input=${u.input_tokens} cache_creation=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0} output=${u.output_tokens}`
      );
    }
    return data.content.map((block) => block.text || '').join('').trim();
  }
}

module.exports = { generate };
