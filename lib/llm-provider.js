const MOCK_RESPONSE = JSON.stringify({
  "titulo": "Cuatro Regalos de Mi Vida",
  "voz": "Femenina",
  "trato": "Tú",
  "estiloSuno": "Balada, tempo moderado, piano suave y cuerdas cálidas, acompañamiento emocional y delicado, voz femenina expresiva y cercana llena de amor y gratitud, sonido íntimo y sentimental, love ballad, emotional, heartfelt, Latin American Spanish, neutral accent, seseo",
  "letras": {
    "Verse 1": [
      "Recuerdo el miedo de sentir una vida moviéndose por primera vez,",
      "sin saber si sería suficiente para darte lo que mereces.",
      "Scarlet, llegaste un veinticinco de septiembre del dos mil seis,",
      "y en mis brazos aprendí lo que significa amar sin condición."
    ],
    "Chorus 1": [
      "Hoy le pido a Dios que cuide cada paso que ustedes dan,",
      "que la vida les regrese en bendiciones lo que un día les di.",
      "Emanuel, llegaste luchando desde el vientre por vivir,",
      "y esa fuerza me enseñó que naciste para nunca rendirte."
    ],
    "Verse 2": [
      "Un quince de enero llegaste pequeño, rosado y con mucho pelo,",
      "tu carita tierna llenó de ternura toda la casa.",
      "Nestor, viajamos juntos hasta el Ecuador tú y yo,",
      "y tu sonrisa alegre se quedó grabada para siempre en mí."
    ],
    "Chorus 2": [
      "Estoy orgullosa de cada camino que ustedes han decidido tomar,",
      "de ver cómo cada día se acercan más a lo que Dios les prometió.",
      "Erick, desde la barriga ya dabas guerra por nacer,",
      "y hoy veo en tu alegría la fuerza que te hace un guerrero."
    ],
    "Bridge": [
      "Perdónenme si alguna vez sintieron que les faltó algo más,",
      "porque les di todo lo que pude con el amor que llevo dentro.",
      "Si un día ya no estoy en este mundo para verlos crecer,",
      "guarden esta canción que escribí con cada latido para ustedes."
    ],
    "Outro": [
      "Los amo más que a mi propia vida, eso nunca cambiará,",
      "mientras tenga aliento aquí estaré para aplaudir cada logro.",
      "Que Dios los cuide y los bendiga en cada paso que den,",
      "mamá los ama por siempre, eso lo pueden asegurar."
    ]
  },
  "qaChecklist": {
    "6_secciones_en_orden": true,
    "4_lineas_por_seccion": true,
    "nombre_primera_palabra_chorus": false,
    "nombre_solo_una_vez_por_chorus": true,
    "nombre_ausente_en_verse_1": false,
    "chorus_1_distinto_chorus_2": true,
    "verse_2_con_escena_concreta": true,
    "bridge_con_detalle_vulnerable": true,
    "nada_inventado": true,
    "trato_consistente": true,
    "numeros_meses_completos": true,
    "titulo_no_cantable": true,
    "sin_puntuacion_prohibida": true,
    "sin_lineas_consecutivas_misma_palabra": true,
    "todas_lineas_con_sentido": true,
    "estilo_suno_incluye_seseo": true,
    "sin_dialogos_textuales": true,
    "destinatarios_multiples_balanceados": true,
    "pov_consistente": true,
    "sin_acrostico": true
  },
  "qaDetalle": "Nombre primera palabra: regla de 4 nombres ubica en línea 3. Nombre ausente Verse 1: Scarlet en línea 3.",
  "foneticaAplicada": false,
  "advertencias": "Ninguna re-escritura fonética."
}, null, 2);

// Claves reales del bloque qaChecklist del RESPONSE FORMAT (SYSTEM_PROMPT en
// run.js) — se supone que es "una sola fuente de verdad" para armar el JSON
// schema de Claude y el de Gemini sin duplicar la lista dos veces, PERO en la
// práctica es una copia a mano del mismo bloque que vive como texto literal
// en run.js — y quedó desincronizada en silencio (detectado 2026-07-08: 20
// claves acá contra 32 reales en el prompt). Como el schema usa
// `additionalProperties: false` + `required: QA_CHECKLIST_KEYS`, cualquier
// clave del checklist que el prompt le pida al modelo pero NO esté acá queda
// forzada fuera de la respuesta real de la API — el modelo nunca puede
// autoevaluarse en esas reglas aunque el texto del prompt se las exija.
// test/llm-provider.test.js compara esta lista contra el bloque real de
// run.js en cada corrida de `npm test` para que esto no vuelva a pasar en
// silencio.
const QA_CHECKLIST_KEYS = [
  '6_secciones_en_orden', '4_lineas_por_seccion', 'nombre_primera_palabra_chorus',
  'nombre_solo_una_vez_por_chorus', 'nombre_ausente_en_verse_1', 'chorus_1_distinto_chorus_2',
  'verse_2_con_escena_concreta', 'bridge_con_detalle_vulnerable', 'nada_inventado',
  'trato_consistente', 'numeros_meses_completos', 'titulo_no_cantable',
  'sin_puntuacion_prohibida', 'sin_lineas_consecutivas_misma_palabra', 'todas_lineas_con_sentido',
  'estilo_suno_incluye_seseo', 'sin_dialogos_textuales', 'destinatarios_multiples_balanceados',
  'pov_consistente', 'sin_acrostico',
  'metrica_corta_y_consistente', 'rima_fuerte_evidente', 'adaptacion_poetica_sin_copypaste',
  'coros_con_gancho', 'vocales_abiertas_en_coro',
  'un_solo_motivo_central', 'cierre_circular_con_verse_1', 'contraste_especifico_vs_universal',
  'sin_inversion_poetica_forzada', 'bridge_con_giro_real', 'linea_de_gancho_quotable',
  'una_metafora_por_linea', 'arco_de_tiempo_verbal_por_seccion', 'ancla_sensorial_en_cada_verso',
  'paralelismo_chorus_1_y_2', 'espacio_negativo_sin_maxima_intensidad_constante',
  'sin_conectores_explicativos', 'rima_rica_no_pobre', 'gancho_en_misma_posicion_metrica',
];
const LYRICS_SECTION_KEYS = ['Verse 1', 'Chorus 1', 'Verse 2', 'Chorus 2', 'Bridge', 'Outro'];

// JSON Schema (draft usado por output_config.format de Anthropic) que fuerza
// la forma exacta descrita en el RESPONSE FORMAT del SYSTEM_PROMPT. No incluye
// minItems/maxItems en los arrays de líneas — la API de Anthropic no soporta
// "complex array constraints" en structured outputs (ver claude-api skill),
// así que el chequeo de "exactamente 4 líneas" se queda en hardValidate()
// como validación posterior, no como garantía del schema.
function buildSongJsonSchema() {
  const lyricsProperties = {};
  for (const sec of LYRICS_SECTION_KEYS) {
    lyricsProperties[sec] = { type: 'array', items: { type: 'string' } };
  }
  const checklistProperties = {};
  for (const key of QA_CHECKLIST_KEYS) {
    checklistProperties[key] = { type: 'boolean' };
  }
  return {
    type: 'object',
    properties: {
      titulo: { type: 'string' },
      voz: { type: 'string', enum: ['Masculina', 'Femenina'] },
      trato: { type: 'string', enum: ['tú', 'usted', 'vos'] },
      estiloSuno: { type: 'string' },
      letras: {
        type: 'object',
        properties: lyricsProperties,
        required: LYRICS_SECTION_KEYS,
        additionalProperties: false,
      },
      qaChecklist: {
        type: 'object',
        properties: checklistProperties,
        required: QA_CHECKLIST_KEYS,
        additionalProperties: false,
      },
      foneticaAplicada: { type: 'boolean' },
      advertencias: { type: 'string' },
    },
    required: ['titulo', 'voz', 'trato', 'estiloSuno', 'letras', 'qaChecklist', 'foneticaAplicada', 'advertencias'],
    additionalProperties: false,
  };
}

// Traduce el mismo schema al formato que espera responseSchema de Gemini
// (subconjunto de OpenAPI 3.0 — SchemaType en mayúsculas de tipo, sin
// "enum" ni "additionalProperties" soportados igual que JSON Schema estándar;
// ver node_modules/@google/generative-ai/dist/generative-ai.d.ts).
function buildGeminiResponseSchema(SchemaType) {
  const lyricsProperties = {};
  for (const sec of LYRICS_SECTION_KEYS) {
    lyricsProperties[sec] = { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } };
  }
  const checklistProperties = {};
  for (const key of QA_CHECKLIST_KEYS) {
    checklistProperties[key] = { type: SchemaType.BOOLEAN };
  }
  return {
    type: SchemaType.OBJECT,
    properties: {
      titulo: { type: SchemaType.STRING },
      voz: { type: SchemaType.STRING },
      trato: { type: SchemaType.STRING },
      estiloSuno: { type: SchemaType.STRING },
      letras: {
        type: SchemaType.OBJECT,
        properties: lyricsProperties,
        required: LYRICS_SECTION_KEYS,
      },
      qaChecklist: {
        type: SchemaType.OBJECT,
        properties: checklistProperties,
        required: QA_CHECKLIST_KEYS,
      },
      foneticaAplicada: { type: SchemaType.BOOLEAN },
      advertencias: { type: SchemaType.STRING },
    },
    required: ['titulo', 'voz', 'trato', 'estiloSuno', 'letras', 'qaChecklist', 'foneticaAplicada', 'advertencias'],
  };
}

// Devuelve { text, stopReason }. stopReason viaja normalizado a los valores de
// la API de Anthropic ('end_turn', 'max_tokens', etc.) — Gemini se mapea a ese
// mismo vocabulario para que el caller (generateSongWithSelfCorrection) pueda
// distinguir "se acabó el presupuesto de tokens" (stopReason === 'max_tokens',
// arreglo: subir maxTokens) de "el contenido está mal" (stopReason === 'end_turn'
// pero no pasa hardValidate, arreglo: instrucciones correctivas) sin importar
// qué proveedor respondió.
async function generate(provider, surveyText, systemPrompt, isDryRun, { maxTokens = 8192 } = {}) {
  if (isDryRun) {
    console.log('--- LOCAL OFFLINE MOCK ACTIVE ---');
    console.log('Returning cached/mock song response text without calling any API...');
    return { text: MOCK_RESPONSE, stopReason: 'end_turn' };
  }

  const maxAttempts = 3;
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      if (provider === 'gemini') {
        if (!process.env.GEMINI_API_KEY) {
          const err = new Error('GEMINI_API_KEY no está configurada. Corré "setx GEMINI_API_KEY <tu-key>" y abrí una terminal nueva.');
          err.noRetry = true; // error de config — reintentar nunca lo arregla
          throw err;
        }
        const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({
          model: 'gemini-3.5-flash',
          systemInstruction: systemPrompt,
          generationConfig: {
            maxOutputTokens: maxTokens,
            temperature: 1.0,
            responseMimeType: 'application/json',
            responseSchema: buildGeminiResponseSchema(SchemaType),
          },
        });
        const result = await model.generateContent(surveyText);
        const finishReason = result.response.candidates?.[0]?.finishReason;
        const stopReason = finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';
        return { text: result.response.text().trim(), stopReason };
      } else {
        if (!process.env.ANTHROPIC_API_KEY) {
          const err = new Error('ANTHROPIC_API_KEY no está configurada. Corré "setx ANTHROPIC_API_KEY <tu-key>" y abrí una terminal nueva.');
          err.noRetry = true; // error de config — reintentar nunca lo arregla
          throw err;
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
            max_tokens: maxTokens,
            // Sonnet 5 corre thinking adaptativo por default si se omite este
            // campo (a diferencia de Sonnet 4.6, que corría sin thinking por
            // default) — el thinking cuenta contra el mismo max_tokens que la
            // letra. Con encuestas de varios destinatarios (6-7 nombres) el
            // thinking se comía el presupuesto entero (8190/8192 tokens) sin
            // dejar nada para la letra: stop_reason "max_tokens", 0 texto.
            // Confirmado con llamada real — ver LESSONS.md.
            thinking: { type: 'disabled' },
            // Fuerza la forma JSON exacta del RESPONSE FORMAT (SYSTEM_PROMPT)
            // a nivel de API, no solo por instrucción de prompt — vuelve
            // estructuralmente imposible la clase de bug de "0 secciones, sin
            // Título" (texto libre que no cumple el formato pedido). Sin
            // beta header, GA.
            output_config: {
              format: {
                type: 'json_schema',
                schema: buildSongJsonSchema(),
              },
            },
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
          const err = new Error(`Anthropic API error ${response.status}: ${await response.text()}`);
          // 4xx (key inválida, request malformado, sin crédito) no se arregla
          // reintentando — solo 429 (rate limit) y 5xx/red son transitorios.
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            err.noRetry = true;
          }
          throw err;
        }

        const data = await response.json();
        if (data.usage) {
          const u = data.usage;
          console.log(
            `  usage: input=${u.input_tokens} cache_creation=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0} output=${u.output_tokens} stop_reason=${data.stop_reason}`
          );
        }
        return {
          text: data.content.map((block) => block.text || '').join('').trim(),
          stopReason: data.stop_reason,
        };
      }
    } catch (err) {
      if (err.noRetry) throw err;
      console.warn(`  ⚠️ Intento de LLM ${attempt}/${maxAttempts} falló: ${err.message}`);
      if (attempt >= maxAttempts) throw err;
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

module.exports = { generate, QA_CHECKLIST_KEYS, buildSongJsonSchema };
