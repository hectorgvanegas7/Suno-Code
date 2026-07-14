// test/song-validate.test.js — Suite de regresión local para hardValidate.
//
// 100% offline: no llama a ninguna API ni abre Chrome. Cubre bugs reales ya
// arreglados en LESSONS.md para que no vuelvan a colarse en un refactor futuro.
// Correr con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { hardValidate, validateContentForWrite, parseSections, isSafeToPatch, applyDeterministicAccentFixes, applyDeterministicLineFixes, numberToSpanishWords } = require('../lib/song-validate');

function buildResponse({
  trato = 'tú',
  estiloSuno = 'Balada, piano suave, Latin American Spanish, neutral accent, seseo',
  verse1 = ['Una tarde tranquila el cielo se abrió', 'Recuerdo esa risa que jamás cambió', 'El tiempo pasaba lento y sereno', 'Algo en mi pecho supo que eras bueno'],
  chorus1 = ['Frank, hoy te canto con todo mi amor', 'Gracias por darme siempre tu calor', 'Cada momento contigo brilla mejor', 'Eres mi orgullo y mi mayor honor'],
  // OJO: la línea 4 decía "Sos ejemplo puro de humanidad" — un VOSEO colado
  // en el propio fixture con trato tú, que nadie detectó durante meses porque
  // hardValidate no validaba el trato tú (el mismo hueco del bug real
  // "más de vos" del 2026-07-09). Confirmación involuntaria del gap.
  chorus2 = ['Frank, admiro tu fuerza y tu bondad', 'Marcaste mi vida con sinceridad', 'Nunca dudé de tu generosidad', 'Eres ejemplo puro de humanidad',],
  verse2 = ['Después de un turno largo volvías feliz', 'Sacabas fuerzas para hacernos reír', 'Cada tropiezo lo hiciste sentir', 'Como un paso más hacia el porvenir'],
  bridge = ['Aquella noche me tomaste la mano', 'Y prometiste cuidar cada verano', 'Ese instante quedó grabado cercano', 'Fue la prueba de un amor soberano'],
  outro = ['Hoy te prometo un cariño sincero', 'Serás mi guía por todo el sendero', 'Con esta canción te digo primero', 'Te voy a amar por siempre entero'],
  checklist = {},
  preamble = '',
  advertencias = 'Ninguna',
  foneticaAplicada = false,
} = {}) {
  const baseChecklist = {
    "6_secciones_en_orden": true,
    "4_lineas_por_seccion": true,
    "nombre_primera_palabra_chorus": true,
    "nombre_solo_una_vez_por_chorus": true,
    "nombre_ausente_en_verse_1": true,
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
    "sin_acrostico": true,
    "metrica_corta_y_consistente": true,
    "rima_fuerte_evidente": true,
    "adaptacion_poetica_sin_copypaste": true,
    "coros_con_gancho": true,
    "vocales_abiertas_en_coro": true
  };

  const finalChecklist = { ...baseChecklist, ...checklist };

  const json = {
    titulo: "Mi Canción Eterna",
    voz: "Masculina",
    trato,
    estiloSuno,
    letras: {
      "Verse 1": verse1,
      "Chorus 1": chorus1,
      "Verse 2": verse2,
      "Chorus 2": chorus2,
      "Bridge": bridge,
      "Outro": outro
    },
    qaChecklist: finalChecklist,
    advertencias,
    foneticaAplicada,
  };

  return preamble + JSON.stringify(json, null, 2);
}

const SURVEY_SINGLE = "What's their name?: Frank";
const SURVEY_MULTI = "What's their name?: Mis hijos Christopher y Soraya.";

test('caso base válido pasa sin fallos', () => {
  const { valid, failures } = hardValidate(buildResponse(), SURVEY_SINGLE);
  assert.equal(valid, true, `esperaba válido, fallos: ${failures.join(' | ')}`);
});

test('eñe perdida ("ano" en vez de "año", "pequena" en vez de "pequeña") se detecta y queda parcheable', () => {
  // Bug real (2026-07-11, "Fogata en la Arena"): pasó hardValidate entero con
  // "ano" en vez de "año" y "pequena" en vez de "pequeña" — nada chequeaba
  // ortografía de palabras comunes, solo nombres propios.
  const response = buildResponse({
    chorus1: ['Frank, hoy cumples otro ano de vida', 'Gracias por darme siempre tu calor', 'Cada momento contigo brilla mejor', 'Eres mi orgullo y mi mayor honor'],
    verse2: ['Recuerdo tus pequenas manos de niño', 'Sacabas fuerzas para hacernos reír', 'Cada tropiezo lo hiciste sentir', 'Como un paso más hacia el porvenir'],
  });
  const { valid, failures, patchableIssues } = hardValidate(response, SURVEY_SINGLE);
  assert.equal(valid, false);
  const enyeFailures = failures.filter((f) => f.startsWith('Eñe/tilde perdida'));
  assert.equal(enyeFailures.length, 2, `esperaba 2 fallos de eñe, encontrados: ${enyeFailures.join(' | ')}`);
  assert.ok(enyeFailures.some((f) => f.includes('"ano"') && f.includes('"año"')));
  assert.ok(enyeFailures.some((f) => f.includes('"pequenas"')));
  assert.equal(isSafeToPatch(failures), true, 'debería quedar como caso parcheable barato, no forzar regen completo');
  assert.equal(patchableIssues.filter((p) => p.kind === 'enye_typo').length, 2);
});

test('eñe/tilde perdida: chequeo GENERAL contra diccionario detecta palabras fuera de la lista de bloqueo fija ("corazon"/"cancion")', () => {
  // A diferencia del caso anterior (blocklist explícita para homógrafos como
  // "ano"), esto prueba que el chequeo NO depende de una lista fija de pares
  // conocidos — lib/spanish-spellcheck.js compara contra un diccionario real
  // de español (nspell + dictionary-es), así que cualquier palabra inválida
  // sin tilde queda cubierta, no solo las ya vistas antes.
  const response = buildResponse({
    outro: ['Guardo en mi corazon tu dulce cancion', 'Serás mi guía por todo el sendero', 'Con esta canción te digo primero', 'Te voy a amar por siempre entero'],
  });
  const { valid, failures } = hardValidate(response, SURVEY_SINGLE);
  assert.equal(valid, false);
  const enyeFailures = failures.filter((f) => f.startsWith('Eñe/tilde perdida'));
  assert.ok(enyeFailures.some((f) => f.includes('"corazon"') && f.includes('"corazón"')), `esperaba detectar "corazon", encontrados: ${enyeFailures.join(' | ')}`);
});

test('eñe/tilde perdida: palabras ambiguas válidas en ambas formas ("mas"/"solo"/"aun") NO disparan falso positivo', () => {
  // "mas" (conjunción "pero"), "solo" (adjetivo "en soledad") y "aun"
  // ("incluso") son palabras reales de por sí, sin tilde — no se puede saber
  // por ortografía sola si el LLM quiso decir "más"/"sólo"/"aún". El chequeo
  // debe abstenerse en vez de forzar una corrección posiblemente incorrecta.
  const response = buildResponse({
    bridge: ['Mas allá del tiempo te sigo esperando', 'Solo tu amor calma mi corazón', 'Aun en la noche siento tu bendición', 'Fue la prueba de un amor soberano'],
  });
  const { failures } = hardValidate(response, SURVEY_SINGLE);
  const enyeFailures = failures.filter((f) => f.startsWith('Eñe/tilde perdida'));
  assert.deepEqual(enyeFailures, [], `no debería marcar palabras ambiguas, encontrado: ${enyeFailures.join(' | ')}`);
});

test('límites de palabra con tildes: "venía"/"decírselo" no disparan falso mezcla de trato con usted', () => {
  // Bug real (LESSONS.md): \b de JS no trata á é í ó ú ñ como word chars, así
  // que \bvení\b matchea DENTRO de "venía" y \bdecí\b DENTRO de "decírselo".
  const response = buildResponse({
    trato: 'usted',
    verse2: ['Usted siempre venía después del trabajo', 'Sin decírselo a nadie ayudaba primero', 'Cada gesto suyo era un abrazo', 'Su ejemplo quedó como un lucero'],
  });
  const { failures } = hardValidate(response, SURVEY_SINGLE);
  const mismatchFailures = failures.filter((f) => f.startsWith('Mezcla de trato'));
  assert.deepEqual(mismatchFailures, [], `no debería marcar mezcla de trato, encontrado: ${mismatchFailures.join(' | ')}`);
});

test('mezcla de trato real (vos con usted declarado) sí se detecta', () => {
  const response = buildResponse({
    trato: 'usted',
    verse2: ['Vos siempre llegabas después del trabajo', 'Y ayudabas a todos sin pedir nada', 'Cada gesto tuyo era un abrazo', 'Tu ejemplo quedó como una fachada'],
  });
  const { failures } = hardValidate(response, SURVEY_SINGLE);
  assert.ok(failures.some((f) => f.startsWith('Mezcla de trato')), 'debería detectar la mezcla de trato real');
});

test('BUG REAL 2026-07-09 ("Luz Que No Buscaba"): "más de vos" con trato tú se detecta', () => {
  // La línea exacta que llegó al audio generado en vivo: las reglas de rima
  // fuerte empujan a rimar con "voz/dos/sol" y el modelo cerró el verso con
  // "vos" — y el validador no miraba el trato tú, así que pasó limpio hasta
  // gastar créditos. Frenado a mano antes del Submit.
  const response = buildResponse({
    trato: 'tú',
    verse1: ['En un salón de escuela te escuché por primera vez', 'Zamara te decían, un nombre que después perdí', 'No hablabas mucho pero algo en tu mirar quedó', 'Cuando te fuiste de ahí yo quise saber más de vos'],
  });
  const { valid, failures } = hardValidate(response, SURVEY_SINGLE);
  assert.equal(valid, false);
  assert.ok(
    failures.some((f) => f.startsWith('Mezcla de trato') && /"vos"/.test(f)),
    `debería detectar "vos" con trato tú, fallos: ${failures.join(' | ')}`
  );
});

test('mezcla de trato: voseo verbal ("sos"/"tenés") con trato tú se detecta', () => {
  const response = buildResponse({
    trato: 'tú',
    bridge: ['Aquella noche me tomaste la mano', 'Sos la promesa que cuidó el verano', 'Ese instante quedó grabado cercano', 'Fue la prueba de un amor soberano'],
  });
  const { failures } = hardValidate(response, SURVEY_SINGLE);
  assert.ok(failures.some((f) => f.startsWith('Mezcla de trato') && /"sos"/i.test(f)));
});

test('mezcla de trato: voseo DENTRO de otra palabra ("versos" contiene "sos") no dispara falso positivo con trato tú', () => {
  // Mismo criterio de límites acentuados que usted ("vení" vs "venía").
  const response = buildResponse({
    trato: 'tú',
    verse2: ['Los versos que te escribo nacen de este amor', 'Sacabas fuerzas para hacernos reír', 'Cada tropiezo lo hiciste sentir', 'Como un paso más hacia el porvenir'],
  });
  const { failures } = hardValidate(response, SURVEY_SINGLE);
  const mismatchFailures = failures.filter((f) => f.startsWith('Mezcla de trato'));
  assert.deepEqual(mismatchFailures, [], `"versos" no es voseo: ${mismatchFailures.join(' | ')}`);
});

test('mezcla de trato: marcadores de tú ("contigo"/"eres") con trato vos se detectan', () => {
  // El fixture base usa tuteo ("contigo", "Eres") — declarar trato vos debe fallar.
  const { failures } = hardValidate(buildResponse({ trato: 'vos' }), SURVEY_SINGLE);
  assert.ok(failures.some((f) => f.startsWith('Mezcla de trato')));
});

test('ítem true condicional "(si aplica)" pasa', () => {
  const response = buildResponse({
    checklist: { "destinatarios_multiples_balanceados": true },
  });
  const { valid, failures } = hardValidate(response, SURVEY_SINGLE);
  assert.equal(valid, true, `no debería fallar por true condicional: ${failures.join(' | ')}`);
});

test('texto antes del JSON (preámbulo filtrado) falla la validación', () => {
  const response = buildResponse({
    preamble: 'I need to fully restructure this song because the original had extra sections.\n\n',
  });
  const { valid, failures } = hardValidate(response, SURVEY_SINGLE);
  assert.equal(valid, false);
  assert.ok(
    failures.some((f) => f.includes('texto antes del JSON')),
    `esperaba fallo de preámbulo, fallos: ${failures.join(' | ')}`
  );
});

test('línea de checklist marcada con false cuenta como fallo', () => {
  const response = buildResponse({ checklist: { "sin_dialogos_textuales": false } });
  const { valid, failures } = hardValidate(response, SURVEY_SINGLE);
  assert.equal(valid, false);
  assert.ok(
    failures.some((f) => f.includes('Claude marcó fallo en checklist') && f.includes('sin_dialogos_textuales')),
    `esperaba fallo por false, fallos: ${failures.join(' | ')}`
  );
});

test('cualquier línea de checklist en false cuenta como fallo', () => {
  const response = buildResponse({ checklist: { "titulo_no_cantable": false } });
  const { valid, failures } = hardValidate(response, SURVEY_SINGLE);
  assert.equal(valid, false);
  assert.ok(failures.some((f) => f.includes('titulo_no_cantable')), `fallos: ${failures.join(' | ')}`);
});

test('extracción de nombres multi-destinatario: "Mis hijos Christopher y Soraya" no confunde "mis" con un nombre', () => {
  // Bug real (LESSONS.md): tomar la primera palabra del campo daba "Mis" como
  // nombre y el validador exigía que los choruses empezaran con "Mis".
  const chorus1 = ['Christopher, hoy quiero darte mi calor', 'Eres ejemplo de esfuerzo y de valor', 'Cada día me llenas de honor', 'Gracias por tu enorme corazón'];
  const chorus2 = ['Soraya, tu risa ilumina el hogar', 'Con tu fuerza me enseñaste a soñar', 'Nunca vas a dejar de brillar', 'Los dos son mi razón de celebrar'];
  const response = buildResponse({
    chorus1,
    chorus2,
    checklist: { "destinatarios_multiples_balanceados": true },
  });
  const { failures } = hardValidate(response, SURVEY_MULTI);
  const nameFailures = failures.filter((f) => f.toLowerCase().includes('mis') || f.includes('primera palabra'));
  assert.deepEqual(nameFailures, [], `no debería confundir "mis" con un nombre, fallos: ${nameFailures.join(' | ')}`);
  assert.ok(!failures.some((f) => f.includes('Christopher') && f.includes('no aparece')), 'Christopher debe reconocerse como presente');
  assert.ok(!failures.some((f) => f.includes('Soraya') && f.includes('no aparece')), 'Soraya debe reconocerse como presente');
});

test('2 destinatarios: ambos nombres en el mismo coro viola la regla posicional (Chorus 1 = Nombre 1, Chorus 2 = Nombre 2)', () => {
  const response = buildResponse({
    chorus1: ['Christopher y Soraya, los dos son mi calor', 'Eres ejemplo de esfuerzo y de valor', 'Cada día me llenas de honor', 'Gracias por su enorme corazón'],
    chorus2: ['Ustedes dos iluminan el hogar', 'Con su fuerza me enseñaron a soñar', 'Nunca van a dejar de brillar', 'Los dos son mi razón de celebrar'],
    checklist: { "destinatarios_multiples_balanceados": true },
  });
  const { valid, failures } = hardValidate(response, SURVEY_MULTI);
  assert.equal(valid, false);
  assert.ok(failures.some((f) => f.includes('mismo coro')), `debería detectar ambos nombres en el mismo coro, fallos: ${failures.join(' | ')}`);
  assert.ok(failures.some((f) => f.includes('línea') && f.toLowerCase().includes('christopher') && f.toLowerCase().includes('soraya')), `debería detectar los dos nombres juntos en una línea, fallos: ${failures.join(' | ')}`);
});

test('4 destinatarios: cada nombre en línea 3 de su sección designada pasa sin fallos de posición', () => {
  // Mismo patrón que el MOCK_RESPONSE real de lib/llm-provider.js (Scarlet/
  // Emanuel/Nestor/Erick) — Verse 1 → Nombre 1, Chorus 1 → Nombre 2, Verse 2 →
  // Nombre 3, Chorus 2 → Nombre 4, todos en línea 3 de su sección.
  const survey4 = "What's their name?: Ana, Beto, Caro y Dani";
  const response = buildResponse({
    verse1: ['Una tarde tranquila el cielo se abrió', 'Recuerdo esa risa que jamás cambió', 'Ana, llegaste como un regalo del cielo', 'Algo en mi pecho supo que eras bueno'],
    chorus1: ['Hoy le pido a Dios que los cuide a los cuatro', 'Que la vida les regrese bendiciones', 'Beto, tu fuerza siempre fue un milagro', 'Y esa fuerza guía mis oraciones'],
    verse2: ['Después de un turno largo volvías feliz', 'Sacabas fuerzas para hacernos reír', 'Caro, tu risa alegre lo dice', 'Como un paso más hacia el porvenir'],
    chorus2: ['Estoy orgullosa de cada camino tomado', 'De ver cómo cada día se acercan más', 'Dani, desde chiquito diste guerra a tu lado', 'Y hoy veo en tu alegría tu disfraz'],
    checklist: { "destinatarios_multiples_balanceados": true },
  });
  const { failures } = hardValidate(response, survey4);
  const positionFailures = failures.filter((f) => f.includes('línea 3') || f.includes('no aparece'));
  assert.deepEqual(positionFailures, [], `no debería marcar fallos posicionales para el patrón de 4 nombres, fallos: ${positionFailures.join(' | ')}`);
});

test('4 destinatarios: nombre fuera de la línea 3 de su sección designada sí se detecta', () => {
  const survey4 = "What's their name?: Ana, Beto, Caro y Dani";
  const response = buildResponse({
    // "Ana" nunca aparece en Verse 1 — debería fallar la regla de 4 nombres.
    verse1: ['Una tarde tranquila el cielo se abrió', 'Recuerdo esa risa que jamás cambió', 'El tiempo pasaba lento y sereno', 'Algo en mi pecho supo que eras bueno'],
    chorus1: ['Hoy le pido a Dios que los cuide a los cuatro', 'Que la vida les regrese bendiciones', 'Beto, tu fuerza siempre fue un milagro', 'Y esa fuerza guía mis oraciones'],
    verse2: ['Después de un turno largo volvías feliz', 'Sacabas fuerzas para hacernos reír', 'Caro, tu risa alegre lo dice', 'Como un paso más hacia el porvenir'],
    chorus2: ['Estoy orgullosa de cada camino tomado', 'De ver cómo cada día se acercan más', 'Dani, desde chiquito diste guerra a tu lado', 'Y hoy veo en tu alegría tu disfraz'],
    checklist: { "destinatarios_multiples_balanceados": true },
  });
  const { valid, failures } = hardValidate(response, survey4);
  assert.equal(valid, false);
  assert.ok(failures.some((f) => f.includes('[Verse 1]') && f.includes('línea 3') && f.toLowerCase().includes('ana')), `debería detectar que Ana falta en la línea 3 de Verse 1, fallos: ${failures.join(' | ')}`);
});

test('5+ destinatarios con nombres largos y terminados en vocal acentuada (José, Bernabé) se detectan sin falsos negativos', () => {
  // Bug real encontrado al escribir este test: \b nativo de JS no trata á/é/
  // í/ó/ú/ñ como caracteres de palabra, así que un nombre que TERMINA en vocal
  // acentuada (José, Bernabé) nunca matcheaba con \bJosé\b — la validación
  // reportaba "el nombre no aparece" aunque estuviera ahí. Fix: nameRegex()
  // en song-validate.js pasó a lookbehind/lookahead contra el alfabeto
  // español, igual que el chequeo de trato más abajo en el mismo archivo.
  const survey6 = "What's their name?: Maximiliano, Guadalupe, Bernabé, Estefanía, José y Jonathan";
  const response = buildResponse({
    verse1: ['Una tarde tranquila el cielo se abrió', 'Recuerdo esa risa que jamás cambió', 'Maximiliano, llegaste como un regalo', 'Algo en mi pecho supo que eras bueno'],
    chorus1: ['Hoy le pido a Dios que los cuide a todos', 'Que la vida les regrese bendiciones', 'Guadalupe, tu fuerza fue un milagro', 'Y esa fuerza guía mis oraciones'],
    verse2: ['Después de un turno largo volvías feliz', 'Sacabas fuerzas para hacernos reír', 'Bernabé, tu risa alegre lo dice', 'Como un paso más hacia el porvenir'],
    chorus2: ['Estoy orgullosa de cada camino tomado', 'De ver cómo cada día se acercan más', 'Estefanía, desde chica diste guerra', 'Y hoy veo en tu alegría tu disfraz'],
    bridge: ['Perdónenme si alguna vez sintieron', 'que les faltó algo más en el camino', 'José, tu nombre vive en cada verso', 'guarden esta canción como un destino'],
    outro: ['Los amo más que a mi propia vida', 'eso nunca en la vida cambiará', 'Jonathan, mi amor siempre en tu partida', 'esta canción por siempre les quedará'],
    checklist: { "destinatarios_multiples_balanceados": true },
  });
  const { failures } = hardValidate(response, survey6);
  const nameFailures = failures.filter((f) => f.includes('no aparece') || f.includes('mismo coro') || f.includes('menciona más de un destinatario'));
  assert.deepEqual(nameFailures, [], `no debería marcar fallos de nombre para 6 destinatarios bien distribuidos, fallos: ${nameFailures.join(' | ')}`);
});

test('encuesta larga y verbosa (miles de caracteres) no rompe extractFirstNames ni el parseo del JSON de respuesta', () => {
  const relleno = 'Recordamos tantos momentos juntos, risas, viajes, tardes de domingo en familia, '.repeat(80);
  const surveyLarga = [
    "What's their name?: José y María",
    `Their beautiful qualities: ${relleno}`,
    `Special moments together: ${relleno}`,
    `Special message: ${relleno}`,
  ].join('\n');

  const advertenciasLarga = 'Se aplicó re-escritura fonética menor para mejorar la pronunciación de Suno. '.repeat(20);

  const response = buildResponse({
    chorus1: ['José, hoy te canto con todo mi amor', 'Gracias por darme siempre tu calor', 'Cada momento contigo brilla mejor', 'Eres mi orgullo y mi mayor honor'],
    chorus2: ['María, admiro tu fuerza y tu bondad', 'Marcaste mi vida con sinceridad', 'Nunca dudé de tu generosidad', 'Eres ejemplo puro de humanidad'],
    checklist: { "destinatarios_multiples_balanceados": true },
    advertencias: advertenciasLarga,
  });

  const { valid, failures, parsedJson } = hardValidate(response, surveyLarga);
  assert.equal(valid, true, `una encuesta/respuesta verbosa no debería romper el parseo ni la validación, fallos: ${failures.join(' | ')}`);
  assert.equal(parsedJson.advertencias, advertenciasLarga, 'el JSON debería parsearse completo, sin truncar el campo largo');
});

test('patchableIssues: dígito y puntuación prohibida se ubican con sección+línea exactas', () => {
  const response = buildResponse({
    verse2: ['Llegaste un 2008 lleno de ilusión', 'Sin saber; que cambiarías mi vida', 'Cada tropiezo lo hiciste sentir', 'Como un paso más hacia el porvenir'],
  });
  const { patchableIssues } = hardValidate(response, SURVEY_SINGLE);
  const digitIssue = patchableIssues.find((p) => p.kind === 'digit');
  const punctIssue = patchableIssues.find((p) => p.kind === 'punctuation');
  assert.ok(digitIssue, 'debería reportar un patchableIssue de tipo digit');
  assert.equal(digitIssue.section, 'Verse 2');
  assert.equal(digitIssue.lineIndex, 0);
  assert.ok(punctIssue, 'debería reportar un patchableIssue de tipo punctuation');
  assert.equal(punctIssue.section, 'Verse 2');
  assert.equal(punctIssue.lineIndex, 1);
});

test('isSafeToPatch: true solo cuando TODOS los fallos son de categorías parcheables', () => {
  assert.equal(isSafeToPatch(['Número en dígitos encontrado: "2008" — debe estar en palabras']), true);
  assert.equal(isSafeToPatch([
    'Puntuación prohibida encontrada: ";" — usar solo comas',
    'Frase incoherente detectada: "genuyo"',
  ]), true);
  assert.equal(isSafeToPatch([]), false, 'sin fallos no debería activar el camino de parche (nada que parchear)');
  assert.equal(isSafeToPatch([
    'Número en dígitos encontrado: "2008" — debe estar en palabras',
    'El nombre "ana" no aparece en la letra, pero es uno de los destinatarios declarados',
  ]), false, 'un solo fallo no-parcheable (nombre) debe bloquear todo el camino de parche, aunque el resto sí sean parcheables');
});

test('nombre incorrecto en Chorus 1 (single-recipient) sí se detecta', () => {
  const response = buildResponse({
    chorus1: ['Roberto, hoy te canto con todo mi amor', 'Gracias por darme siempre tu calor', 'Cada momento contigo brilla mejor', 'Eres mi orgullo y mi mayor honor'],
  });
  const { valid, failures } = hardValidate(response, SURVEY_SINGLE);
  assert.equal(valid, false);
  assert.ok(failures.some((f) => f.includes('[Chorus 1]') && f.includes('primera palabra')), `fallos: ${failures.join(' | ')}`);
});

test('respelling fonético (lib/name-dictionary.json) que cambia la primera letra pasa SOLO con foneticaAplicada=true', () => {
  // lib/name-dictionary.json inyecta reglas como "Geovanny" -> "Yeováni"
  // (G -> Y). El chequeo de "primera palabra del Chorus" en hardValidate
  // tolera esto únicamente vía el flag foneticaAplicada (bypass explícito),
  // no por coincidencia de primera letra — hay que fijar esa dependencia con
  // un test real del diccionario, no solo confiar en que el LLM lo marque bien.
  const SURVEY_GEOVANNY = "What's their name?: Geovanny";
  const response = buildResponse({
    chorus1: ['Yeováni, hoy te canto con todo mi amor', 'Gracias por darme siempre tu calor', 'Cada momento contigo brilla mejor', 'Eres mi orgullo y mi mayor honor'],
    chorus2: ['Yeováni, admiro tu fuerza y tu bondad', 'Marcaste mi vida con sinceridad', 'Nunca dudé de tu generosidad', 'Eres ejemplo puro de humanidad'],
    foneticaAplicada: true,
  });
  const { valid, failures } = hardValidate(response, SURVEY_GEOVANNY);
  assert.equal(valid, true, `esperaba válido con foneticaAplicada=true, fallos: ${failures.join(' | ')}`);
});

test('mismo respelling fonético SIN foneticaAplicada=true sí dispara fallo de primera palabra', () => {
  const SURVEY_GEOVANNY = "What's their name?: Geovanny";
  const response = buildResponse({
    chorus1: ['Yeováni, hoy te canto con todo mi amor', 'Gracias por darme siempre tu calor', 'Cada momento contigo brilla mejor', 'Eres mi orgullo y mi mayor honor'],
    foneticaAplicada: false,
  });
  const { valid, failures } = hardValidate(response, SURVEY_GEOVANNY);
  assert.equal(valid, false);
  assert.ok(failures.some((f) => f.includes('[Chorus 1]') && f.includes('primera palabra')), `fallos: ${failures.join(' | ')}`);
});

test('nombre presente en Verse 1 (single-recipient) se detecta como fuga', () => {
  const response = buildResponse({
    verse1: ['Frank caminaba solo aquella tarde', 'Recuerdo esa risa que jamás cambió', 'El tiempo pasaba lento y sereno', 'Algo en mi pecho supo que eras bueno'],
  });
  const { valid, failures } = hardValidate(response, SURVEY_SINGLE);
  assert.equal(valid, false);
  assert.ok(failures.some((f) => f.includes('[Verse 1]') && f.toLowerCase().includes('frank')), `fallos: ${failures.join(' | ')}`);
});

test('nombre corto que colisiona con una palabra común ("al") no dispara falsa fuga en Verse 1', () => {
  // Bug real (LESSONS.md, incidente "Al"): con nombre de encuesta "Al", una
  // línea de Verse 1 con la preposición "al" ("sonriendo al caminar") o con
  // palabras que contienen esas letras ("cristal", "final", "igual") quemó 3
  // intentos de generación seguidos porque el chequeo viejo era un
  // .includes()/split case-insensitive sin límite de palabra ni de mayúscula.
  const surveyAl = "What's their name?: Al";
  const response = buildResponse({
    chorus1: ['Aal, hoy te canto con todo mi amor', 'Gracias por darme siempre tu calor', 'Cada momento contigo brilla mejor', 'Eres mi orgullo y mi mayor honor'],
    chorus2: ['Aal, admiro tu fuerza y tu bondad', 'Marcaste mi vida con sinceridad', 'Nunca dudé de tu generosidad', 'Eres ejemplo puro de humanidad'],
    verse1: ['Salía de una pizzería una tarde cualquiera', 'Ibas con tu amiga sonriendo al caminar', 'Todo se veía igual, como un cristal', 'Te invité a compartir la pizza sin imaginar'],
  });
  const { failures } = hardValidate(response, surveyAl);
  const leakFailures = failures.filter((f) => f.includes('[Verse 1]') && f.includes('debe estar ausente'));
  assert.deepEqual(leakFailures, [], `no debería marcar "al" como nombre filtrado, fallos: ${leakFailures.join(' | ')}`);
});

test('nombre corto SÍ capitalizado y como palabra propia en Verse 1 sigue detectándose como fuga', () => {
  // La comparación case-sensitive no debe dejar de detectar una fuga real solo
  // porque el nombre es corto: si "Al" aparece como palabra independiente y
  // capitalizada (como se dirigiría a la persona), sigue siendo una fuga.
  const surveyAl = "What's their name?: Al";
  const response = buildResponse({
    chorus1: ['Aal, hoy te canto con todo mi amor', 'Gracias por darme siempre tu calor', 'Cada momento contigo brilla mejor', 'Eres mi orgullo y mi mayor honor'],
    chorus2: ['Aal, admiro tu fuerza y tu bondad', 'Marcaste mi vida con sinceridad', 'Nunca dudé de tu generosidad', 'Eres ejemplo puro de humanidad'],
    verse1: ['Al, siempre fuiste mi mejor amigo', 'Recuerdo esa risa que jamás cambió', 'El tiempo pasaba lento y sereno', 'Algo en mi pecho supo que eras bueno'],
  });
  const { failures } = hardValidate(response, surveyAl);
  assert.ok(
    failures.some((f) => f.includes('[Verse 1]') && f.includes('debe estar ausente')),
    `debería seguir detectando la fuga real de "Al", fallos: ${failures.join(' | ')}`
  );
});

test('conteo de ocurrencias en Chorus no se infla por una palabra que contiene el nombre como substring', () => {
  // Mismo bug de raíz que la fuga en Verse 1, pero en el conteo "una sola vez
  // por chorus": con nombre "al", una palabra como "cristal" en el mismo
  // chorus no debe contarse como una segunda mención del nombre.
  const surveyAl = "What's their name?: Al";
  const response = buildResponse({
    chorus1: ['Aal, tu amor brilla como un cristal', 'Gracias por darme siempre tu calor', 'Cada momento contigo brilla mejor', 'Eres mi orgullo y mi mayor honor'],
    chorus2: ['Aal, admiro tu fuerza y tu bondad', 'Marcaste mi vida con sinceridad', 'Nunca dudé de tu generosidad', 'Eres ejemplo puro de humanidad'],
    verse1: ['Salía de una pizzería una tarde cualquiera', 'Todo se veía normal y sereno', 'El tiempo pasaba lento aquel día', 'Algo en mi pecho supo que eras bueno'],
  });
  const { failures } = hardValidate(response, surveyAl);
  const countFailures = failures.filter((f) => f.includes('[Chorus 1]') && f.includes('veces'));
  assert.deepEqual(countFailures, [], `no debería inflar el conteo por "cristal", fallos: ${countFailures.join(' | ')}`);
});

test('Chorus 1 idéntico a Chorus 2 se detecta', () => {
  const response = buildResponse({
    chorus2: ['Frank, hoy te canto con todo mi amor', 'Gracias por darme siempre tu calor', 'Cada momento contigo brilla mejor', 'Eres mi orgullo y mi mayor honor'],
  });
  const { valid, failures } = hardValidate(response, SURVEY_SINGLE);
  assert.equal(valid, false);
  assert.ok(failures.includes('Chorus 1 y Chorus 2 son idénticos'), `fallos: ${failures.join(' | ')}`);
});

test('dígitos en la letra se detectan (números deben ir en palabras)', () => {
  const response = buildResponse({
    bridge: ['Aquella noche del año 2008', 'Y prometiste cuidar cada verano', 'Ese instante quedó grabado cercano', 'Fue la prueba de un amor soberano'],
  });
  const { valid, failures } = hardValidate(response, SURVEY_SINGLE);
  assert.equal(valid, false);
  assert.ok(failures.some((f) => f.includes('2008')), `fallos: ${failures.join(' | ')}`);
});

test('puntuación prohibida (em dash / punto y coma / dos puntos) se detecta', () => {
  const response = buildResponse({
    outro: ['Hoy te prometo — un cariño sincero', 'Serás mi guía por todo el sendero', 'Con esta canción te digo primero', 'Te voy a amar por siempre entero'],
  });
  const { valid, failures } = hardValidate(response, SURVEY_SINGLE);
  assert.equal(valid, false);
  assert.ok(failures.some((f) => f.includes('Puntuación prohibida')), `fallos: ${failures.join(' | ')}`);
});

test('sección faltante (solo 5 de 6) se detecta con mensaje de orden', () => {
  const baseJson = JSON.parse(buildResponse());
  delete baseJson.letras['Bridge'];
  const brokenResponse = JSON.stringify(baseJson);
  const { valid, failures } = hardValidate(brokenResponse, SURVEY_SINGLE);
  assert.equal(valid, false);
  assert.ok(failures.some((f) => f.includes('Se encontraron 5 secciones')), `fallos: ${failures.join(' | ')}`);
});

test('sección con 3 líneas en vez de 4 se detecta', () => {
  const response = buildResponse({
    outro: ['Hoy te prometo un cariño sincero', 'Serás mi guía por todo el sendero', 'Con esta canción te digo entero'],
  });
  const { valid, failures } = hardValidate(response, SURVEY_SINGLE);
  assert.equal(valid, false);
  assert.ok(failures.some((f) => f.includes('[Outro] tiene 3 línea')), `fallos: ${failures.join(' | ')}`);
});

test('estilo Suno sin "seseo" se detecta', () => {
  const response = buildResponse({ estiloSuno: 'Balada, piano suave, Latin American Spanish, neutral accent' });
  const { valid, failures } = hardValidate(response, SURVEY_SINGLE);
  assert.equal(valid, false);
  assert.ok(failures.includes('Estilo Suno no incluye "seseo" + acento latinoamericano'));
});

test('validateContentForWrite: respuesta cortada justo después de "**Título:**" se detecta como truncación', () => {
  // Simula el caso real de LESSONS.md: la respuesta corta a mitad de generación
  // (stop_reason: max_tokens) y no queda nada después del label.
  const truncated = '{"titulo": "Mi Canci';
  const { ok, failures } = validateContentForWrite(truncated);
  assert.equal(ok, false);
  assert.ok(failures.some((f) => f.includes('Falta **Título:**')), `fallos: ${failures.join(' | ')}`);
});

test('validateContentForWrite: contenido completo pasa', () => {
  const full = JSON.parse(buildResponse());
  const { ok, failures } = validateContentForWrite(full);
  assert.equal(ok, true, `fallos: ${failures.join(' | ')}`);
});

test('parseSections respeta el orden y separa líneas correctamente', () => {
  const { sections, errors } = parseSections(JSON.parse(buildResponse()));
  assert.deepEqual(errors, []);
  assert.equal(sections['Verse 1'].length, 4);
  assert.equal(sections['Chorus 1'][0].startsWith('Frank'), true);
});

test('BUG REAL 2026-07-10 ("El Aire Que Respiro"): "Jesús" respelleado a "Yeous" se detecta como fallo duro', () => {
  // Caso real: el LLM fusionó "Jesús Alejandro" como "Yeousalejandro" al
  // inicio del Chorus, marcando foneticaAplicada=true — el chequeo B (primera
  // palabra del Chorus) lo dejó pasar porque el bypass de foneticaAplicada
  // acepta cualquier variante con la primera letra correcta. Esta regla es
  // independiente de ese bypass: "Jesús" es español estándar, tiene que
  // aparecer con su ortografía real en algún lugar de la letra.
  const response = buildResponse({
    chorus1: ['Yeousalejandro eres mi vida entera', 'eres el aire que respiro cuando espero', 'aunque yo no fui perfecta como madre', 'tú eres lo más lindo que me dio esta tierra'],
    chorus2: ['Yeousalejandro estoy tan orgullosa', 'de cada meta que alcanzas sin soltar la cosa', 'persistente hasta el final aunque el camino pese', 'eres mi razón de ser, mi motor, lo que me mueve'],
    foneticaAplicada: true,
  });
  const { valid, failures } = hardValidate(response, "What's their name?: Jesús Alejandro");
  assert.equal(valid, false);
  assert.ok(
    failures.some((f) => f.includes('Jesús') && f.includes('español estándar')),
    `debería marcar el nombre español estándar respelleado, fallos: ${failures.join(' | ')}`
  );
});

test('nombre español estándar SIN respellear (survey sin tilde, letra con tilde correcta) pasa limpio', () => {
  // extractFirstNames() devuelve el nombre en minúscula y sin tilde tal como
  // lo tipeó el cliente ("jesus") — el chequeo tiene que buscar la ortografía
  // CANÓNICA ("Jesús") en la letra, no la forma cruda de la encuesta.
  const response = buildResponse({
    chorus1: ['Jesús, hoy te canto con todo mi amor', 'Gracias por darme siempre tu calor', 'Cada momento contigo brilla mejor', 'Eres mi orgullo y mi mayor honor'],
    chorus2: ['Jesús, admiro tu fuerza y tu bondad', 'Marcaste mi vida con sinceridad', 'Nunca dudé de tu generosidad', 'Eres ejemplo puro de humanidad'],
  });
  const { failures } = hardValidate(response, "What's their name?: jesus");
  assert.ok(
    !failures.some((f) => f.includes('español estándar')),
    `no debería marcar nada, encontrado: ${failures.filter((f) => f.includes('español estándar')).join(' | ')}`
  );
});

test('BUG REAL 2026-07-13 ("El Lago Donde Aprendí a Quedarme"): "Maria" sin tilde reporta UN solo fallo patcheable, no dos', () => {
  // Caso real: el LLM escribió "Maria" (sin tilde) en vez de "María" tres
  // veces seguidas pese a las instrucciones correctivas. El chequeo H2 (Eñe/
  // tilde perdida, patcheable) ya lo detecta — pero antes el chequeo M
  // (nombre español estándar) TAMBIÉN lo marcaba como fallo separado y NO
  // patcheable ("posible re-escritura indebida"), lo cual hacía isSafeToPatch
  // devolver false y forzaba un regen completo caro que no arreglaba nada
  // (3/3 intentos fallidos con el mismo typo). Ahora M se salta cuando la
  // forma sin acentuar ya está cubierta por H2, para que el corrector barato
  // pueda arreglar este typo sin gastar un regen completo.
  const response = buildResponse({
    chorus1: ['Maria, contigo hasta el enojo sabe a casa', 'Tu silencio también lo aprendí a querer', 'Paciente cuando yo ni fui capaz de serlo', 'Sabia cuando el mundo no supo qué hacer'],
    chorus2: ['Maria, la que se enoja y regresa igual de fuerte', 'La que trabaja doble y no deja de amar', 'Sabia en lo simple, terca cuando hace falta', 'Sigues siendo el lugar donde quiero regresar'],
  });
  const { valid, failures } = hardValidate(response, "What's their name?: Maria");
  assert.equal(valid, false);
  assert.equal(
    failures.filter((f) => /maria/i.test(f)).length,
    2,
    `debería reportar solo el fallo H2 (uno por chorus), no el fallo M duplicado: ${failures.join(' | ')}`
  );
  assert.ok(
    !failures.some((f) => f.includes('español estándar')),
    `no debería duplicar como fallo M no-patcheable: ${failures.filter((f) => f.includes('español estándar')).join(' | ')}`
  );
  assert.ok(
    failures.every((f) => f.startsWith('Eñe/tilde perdida')),
    `todos los fallos deberían ser del tipo patcheable H2: ${failures.join(' | ')}`
  );
  assert.equal(isSafeToPatch(failures), true, 'el corrector barato debería poder intentarlo, sin ir directo a un regen completo');
});

test('applyDeterministicAccentFixes: corrige "Maria"->"María" preservando mayúscula, sin tocar el resto de la línea', () => {
  // Mismo caso real de arriba, probando el reemplazo mecánico directo (cero
  // LLM) que ahora corre ANTES del corrector de Haiku en run.js.
  const letras = {
    'Chorus 1': ['Maria, contigo hasta el enojo sabe a casa', 'Tu silencio también lo aprendí a querer'],
    'Chorus 2': ['Maria, la que se enoja y regresa igual de fuerte'],
  };
  const { letras: fixed, appliedCount } = applyDeterministicAccentFixes(letras);
  assert.equal(appliedCount, 2, 'debería corregir las 2 apariciones de "Maria"');
  assert.equal(fixed['Chorus 1'][0], 'María, contigo hasta el enojo sabe a casa');
  assert.equal(fixed['Chorus 1'][1], 'Tu silencio también lo aprendí a querer', 'línea sin typo no debe tocarse');
  assert.equal(fixed['Chorus 2'][0], 'María, la que se enoja y regresa igual de fuerte');

  // El resultado debería pasar hardValidate limpio (sin el fallo de tilde).
  const response = JSON.stringify({
    titulo: 'Test', voz: 'Femenina', trato: 'tú',
    estiloSuno: 'Balada, Latin American Spanish, neutral accent, seseo',
    letras: {
      'Verse 1': ['Una tarde tranquila el cielo se abrió', 'Recuerdo esa risa que jamás cambió', 'El tiempo pasaba lento y sereno', 'Algo en mi pecho supo que eras bueno'],
      'Chorus 1': [fixed['Chorus 1'][0], fixed['Chorus 1'][1], 'Paciente cuando yo ni fui capaz de serlo', 'Sabia cuando el mundo no supo qué hacer'],
      'Verse 2': ['Después de un turno largo volvías feliz', 'Sacabas fuerzas para hacernos reír', 'Cada tropiezo lo hiciste sentir', 'Como un paso más hacia el porvenir'],
      'Chorus 2': [fixed['Chorus 2'][0], 'La que trabaja doble y no deja de amar', 'Sabia en lo simple, terca cuando hace falta', 'Sigues siendo el lugar donde quiero regresar'],
      'Bridge': ['Aquella noche me tomaste la mano', 'Y prometiste cuidar cada verano', 'Ese instante quedó grabado cercano', 'Fue la prueba de un amor soberano'],
      'Outro': ['Hoy te prometo un cariño sincero', 'Serás mi guía por todo el sendero', 'Con esta canción te digo primero', 'Te voy a amar por siempre entero'],
    },
    qaChecklist: {
      "6_secciones_en_orden": true, "4_lineas_por_seccion": true, "nombre_primera_palabra_chorus": true,
      "nombre_solo_una_vez_por_chorus": true, "nombre_ausente_en_verse_1": true, "chorus_1_distinto_chorus_2": true,
      "verse_2_con_escena_concreta": true, "bridge_con_detalle_vulnerable": true, "nada_inventado": true,
      "trato_consistente": true, "numeros_meses_completos": true, "titulo_no_cantable": true,
      "sin_puntuacion_prohibida": true, "sin_lineas_consecutivas_misma_palabra": true, "todas_lineas_con_sentido": true,
      "estilo_suno_incluye_seseo": true, "sin_dialogos_textuales": true, "destinatarios_multiples_balanceados": true,
      "pov_consistente": true, "sin_acrostico": true, "metrica_corta_y_consistente": true, "rima_fuerte_evidente": true,
      "adaptacion_poetica_sin_copypaste": true, "coros_con_gancho": true, "vocales_abiertas_en_coro": true,
      "un_solo_motivo_central": true, "cierre_circular_con_verse_1": true, "contraste_especifico_vs_universal": true,
      "sin_inversion_poetica_forzada": true, "bridge_con_giro_real": true, "linea_de_gancho_quotable": true,
      "una_metafora_por_linea": true, "arco_de_tiempo_verbal_por_seccion": true, "ancla_sensorial_en_cada_verso": true,
      "paralelismo_chorus_1_y_2": true, "espacio_negativo_sin_maxima_intensidad_constante": true,
      "sin_conectores_explicativos": true, "rima_rica_no_pobre": true, "gancho_en_misma_posicion_metrica": true,
    },
    foneticaAplicada: false, advertencias: 'Ninguna',
  });
  const { valid, failures } = hardValidate(response, "What's their name?: Maria");
  assert.equal(valid, true, `debería quedar limpio tras el reemplazo determinístico: ${failures.join(' | ')}`);
});

test('applyDeterministicAccentFixes: no toca nada si no hay typos de tilde', () => {
  const letras = { 'Verse 1': ['Una tarde tranquila el cielo se abrió'] };
  const { letras: fixed, appliedCount } = applyDeterministicAccentFixes(letras);
  assert.equal(appliedCount, 0);
  assert.deepEqual(fixed, letras);
});

test('BUG REAL 2026-07-13 (agujero del Fix A): "Jesus" sin tilde debe reportarse como fallo PATCHEABLE, nunca pasar en silencio', () => {
  // La primera versión del fix de duplicación M/H2 SUPRIMÍA el fallo de M
  // cuando la forma sin acentuar estaba en la letra, asumiendo que H2 ya lo
  // reportaba. Falso para 42/58 nombres acentuados de la lista estándar:
  // dictionary-es no acepta "jesús"/"josé" en minúscula, así que H2 no los
  // ve — "Jesus" y "Jose" sin tilde pasaban la validación ENTERA (verificado
  // en vivo 2026-07-13). Ahora M reclasifica ese caso como "Eñe/tilde
  // perdida" (patcheable, con sección+línea) en vez de suprimirlo.
  const response = buildResponse({
    chorus1: ['Jesus, hoy te canto con todo mi amor', 'Gracias por darme siempre tu calor', 'Cada momento contigo brilla mejor', 'Eres mi orgullo y mi mayor honor'],
    chorus2: ['Jesus, admiro tu fuerza y tu bondad', 'Marcaste mi vida con sinceridad', 'Nunca dudé de tu generosidad', 'Eres ejemplo puro de humanidad'],
  });
  const { valid, failures, patchableIssues } = hardValidate(response, "What's their name?: jesus");
  assert.equal(valid, false, 'el typo "Jesus" sin tilde JAMÁS debe pasar la validación en silencio');
  const jesusFailures = failures.filter((f) => f.includes('"jesus"') && f.includes('"Jesús"'));
  assert.equal(jesusFailures.length, 2, `debería reportar el typo en ambos chorus: ${failures.join(' | ')}`);
  assert.ok(
    jesusFailures.every((f) => f.startsWith('Eñe/tilde perdida')),
    `debe ser el prefijo patcheable, no el de respelling: ${jesusFailures.join(' | ')}`
  );
  assert.equal(isSafeToPatch(failures), true, 'el corrector barato debe poder intentarlo');
  assert.equal(
    patchableIssues.filter((i) => i.kind === 'enye_typo' && i.detail.includes('Jesús')).length,
    2,
    'el corrector necesita sección+línea exactas para parchear'
  );
});

test('applyDeterministicAccentFixes con firstNames: corrige "Jesus"->"Jesús" vía la lista de nombres estándar (el diccionario no lo cubre)', () => {
  const letras = {
    'Chorus 1': ['Jesus, hoy te canto con todo mi amor', 'Gracias por darme siempre tu calor'],
    'Chorus 2': ['Jesus, admiro tu fuerza y tu bondad'],
  };
  const { letras: fixed, appliedCount } = applyDeterministicAccentFixes(letras, { firstNames: ['jesus'] });
  assert.equal(appliedCount, 2);
  assert.equal(fixed['Chorus 1'][0], 'Jesús, hoy te canto con todo mi amor');
  assert.equal(fixed['Chorus 2'][0], 'Jesús, admiro tu fuerza y tu bondad');
  assert.equal(fixed['Chorus 1'][1], 'Gracias por darme siempre tu calor', 'línea sin typo no debe tocarse');
});

test('applyDeterministicAccentFixes con firstNames: un token en MINÚSCULA idéntico al nombre puede ser palabra común — no tocar', () => {
  // Destinataria "Tomás" + "cuando tomas mi mano" (verbo tomar): el verbo
  // jamás debe volverse el nombre. Solo las ocurrencias CAPITALIZADAS se
  // corrigen determinísticamente; las minúsculas quedan para Haiku/regen.
  const letras = { 'Verse 2': ['Cuando tomas mi mano todo se calma', 'Tomas, tu fe sostiene mi alma'] };
  const { letras: fixed, appliedCount } = applyDeterministicAccentFixes(letras, { firstNames: ['tomas'] });
  assert.equal(fixed['Verse 2'][0], 'Cuando tomas mi mano todo se calma', 'el verbo en minúscula no se toca');
  assert.equal(fixed['Verse 2'][1], 'Tomás, tu fe sostiene mi alma', 'el nombre capitalizado sí se corrige');
  assert.equal(appliedCount, 1);
});

test('applyDeterministicAccentFixes: homógrafos plausibles del blocklist ("papa", "sueno") se marcan pero NUNCA se auto-reemplazan', () => {
  // Verificado en vivo 2026-07-13: la primera versión convertía "El Papa nos
  // bendijo" en "El Papá nos bendijo" y "yo sueno como campana" en "yo sueño
  // como campana" — reemplazo ciego sin contexto. Esos casos van al corrector
  // de Haiku (que ve la línea completa), no al determinístico.
  const letras = { 'Bridge': ['El Papa nos bendijo aquel verano', 'Yo sueno como campana en la manana'] };
  const { letras: fixed } = applyDeterministicAccentFixes(letras);
  assert.equal(fixed['Bridge'][0], 'El Papa nos bendijo aquel verano', '"Papa" no debe volverse "Papá" sin contexto');
  assert.ok(fixed['Bridge'][1].includes('sueno'), '"sueno" no debe volverse "sueño" sin contexto');
  assert.ok(fixed['Bridge'][1].includes('mañana'), '"manana" (sin ambigüedad de diccionario) sí se corrige en la misma línea');

  // Pero hardValidate SÍ debe seguir marcándolos como fallo patcheable, para
  // que Haiku los arregle — dos niveles de blocklist, no un agujero nuevo.
  const response = buildResponse({ bridge: ['El Papa nos bendijo aquel verano', 'Yo sueno como campana esta vez', 'Ese instante quedó grabado cercano', 'Fue la prueba de un amor soberano'] });
  const { failures } = hardValidate(response, SURVEY_SINGLE);
  assert.ok(failures.some((f) => f.startsWith('Eñe/tilde perdida') && f.includes('"papa"')), `"papa" debe seguir marcándose: ${failures.join(' | ')}`);
  assert.ok(failures.some((f) => f.startsWith('Eñe/tilde perdida') && f.includes('"sueno"')), `"sueno" debe seguir marcándose: ${failures.join(' | ')}`);
});

test('applyDeterministicAccentFixes: preserva TODO MAYÚSCULAS ("MARIA"->"MARÍA", no "María")', () => {
  const letras = { 'Outro': ['MARIA por siempre en mi corazon'] };
  const { letras: fixed } = applyDeterministicAccentFixes(letras);
  assert.ok(fixed['Outro'][0].startsWith('MARÍA'), `esperado "MARÍA...", quedó: ${fixed['Outro'][0]}`);
});

test('numberToSpanishWords: convierte solo los números SIN problemas de género/apócope', () => {
  assert.equal(numberToSpanishWords(15), 'quince');
  assert.equal(numberToSpanishWords(50), 'cincuenta');
  assert.equal(numberToSpanishWords(87), 'ochenta y siete');
  assert.equal(numberToSpanishWords(100), 'cien');
  assert.equal(numberToSpanishWords(11), 'once');
  assert.equal(numberToSpanishWords(1998), 'mil novecientos noventa y ocho');
  assert.equal(numberToSpanishWords(2026), 'dos mil veintiséis');
  assert.equal(numberToSpanishWords(21), null, '21 necesita apócope según el sustantivo (veintiún años) — Haiku con contexto');
  assert.equal(numberToSpanishWords(1), null, 'un/uno/una depende del sustantivo');
  assert.equal(numberToSpanishWords(250), null, 'doscientos/doscientas concuerda en género');
});

test('applyDeterministicLineFixes: puntuación prohibida y dígitos se arreglan sin LLM; lo ambiguo queda para Haiku', () => {
  const letras = {
    'Verse 1': ['Te dije: nunca me voy — quedate cerca; siempre', 'Cumples 15 años de puro amor', 'Hace 21 años que te espero'],
  };
  const { letras: fixed, appliedCount, fixes } = applyDeterministicLineFixes(letras);
  assert.ok(appliedCount >= 2, `esperaba al menos 2 correcciones, hubo ${appliedCount} (${fixes.join(', ')})`);
  assert.ok(!/[—;:]/.test(fixed['Verse 1'][0]), `no debe quedar puntuación prohibida: "${fixed['Verse 1'][0]}"`);
  assert.ok(fixed['Verse 1'][0].includes('Te dije, nunca me voy'), `el reemplazo debe ser por coma: "${fixed['Verse 1'][0]}"`);
  assert.equal(fixed['Verse 1'][1], 'Cumples quince años de puro amor');
  assert.equal(fixed['Verse 1'][2], 'Hace 21 años que te espero', '21 (apócope) se deja intacto para el corrector con contexto');
});

test('nombre NO estándar (anglicanizado) sigue sin chequeo de ortografía exacta — el backstop no le aplica', () => {
  // "Johelyn" no está en la lista curada de nombres españoles estándar — el
  // respelling fonético real (ej. "Yoelin") sigue siendo válido y no debe
  // dispararle este chequeo nuevo.
  const response = buildResponse({
    chorus1: ['Yoelin, hoy te canto con todo mi amor', 'Gracias por darme siempre tu calor', 'Cada momento contigo brilla mejor', 'Eres mi orgullo y mi mayor honor'],
    foneticaAplicada: true,
  });
  const { failures } = hardValidate(response, "What's their name?: Johelyn");
  assert.ok(
    !failures.some((f) => f.includes('español estándar')),
    `no debería aplicar el backstop a nombres no estándar, encontrado: ${failures.filter((f) => f.includes('español estándar')).join(' | ')}`
  );
});

// ── Chequeo N: nombres propios inventados (2026-07-14) ──────────────────────
// Bug real ("El Hombre De Mi Vida"): "un mismo destino nos cruzó por Miami"
// — la encuesta solo mencionaba Cuba y Estados Unidos. Ni el validador ni El
// Guardia (fidelidad=10 en 2 pasadas, incluso con prompt endurecido) lo
// atraparon. Un token capitalizado en MEDIO de línea que no está en la
// encuesta es un nombre propio inventado — detección determinística.

const SURVEY_DAMIAN = "Who's this for?: Esposo\nWhat's their name?: Frank\nSpecial moments: el se fue de Cuba y vine a Estados Unidos, todo empezó un trece de mayo";

test('BUG REAL 2026-07-14 ("El Hombre De Mi Vida"): lugar inventado mid-línea ("Miami") no presente en la encuesta se detecta', () => {
  const response = buildResponse({
    verse1: ['Una tarde tranquila el cielo se abrió', 'La isla se quedó detrás en el silencio', 'Un mismo destino nos cruzó por Miami', 'Algo en mi pecho supo que eras bueno'],
  });
  const { valid, failures } = hardValidate(response, SURVEY_DAMIAN);
  assert.equal(valid, false);
  const inventedFailures = failures.filter((f) => f.startsWith('Nombre propio ausente de la encuesta'));
  assert.equal(inventedFailures.length, 1, `esperaba 1 fallo de nombre inventado, encontrados: ${inventedFailures.join(' | ')}`);
  assert.ok(inventedFailures[0].includes('"Miami"'));
  assert.ok(inventedFailures[0].includes('[Verse 1]'));
  assert.equal(isSafeToPatch(failures), false, 'un hecho inventado NUNCA es parcheable — necesita regen con contexto');
});

test('chequeo N: el mismo lugar mid-línea SÍ presente en la encuesta pasa limpio', () => {
  const response = buildResponse({
    verse1: ['Una tarde tranquila el cielo se abrió', 'La isla se quedó detrás en el silencio', 'Un mismo destino nos cruzó por Miami', 'Algo en mi pecho supo que eras bueno'],
  });
  const { failures } = hardValidate(response, SURVEY_DAMIAN + '\nnos reencontramos en Miami');
  assert.equal(failures.filter((f) => f.startsWith('Nombre propio ausente')).length, 0);
});

test('chequeo N: términos religiosos mid-línea (Dios, Señor) NUNCA se marcan aunque no estén en la encuesta (regla 8 del prompt)', () => {
  const response = buildResponse({
    bridge: ['Aquella noche me tomaste la mano', 'Le pedí a Dios cuidar cada verano', 'La gracia del Señor quedó cercana', 'Fue la prueba de un amor soberano'],
  });
  const { failures } = hardValidate(response, SURVEY_SINGLE);
  assert.equal(failures.filter((f) => f.startsWith('Nombre propio ausente')).length, 0, `fallos inesperados: ${failures.join(' | ')}`);
});

test('chequeo N: capital de INICIO de línea nunca se marca (todas las líneas arrancan capitalizadas)', () => {
  const response = buildResponse({
    verse2: ['Bailamos toda esa noche sin parar', 'Sacabas fuerzas para hacernos reír', 'Cada tropiezo lo hiciste sentir', 'Como un paso más hacia el porvenir'],
  });
  const { failures } = hardValidate(response, SURVEY_SINGLE);
  assert.equal(failures.filter((f) => f.startsWith('Nombre propio ausente')).length, 0);
});

test('chequeo N: respelling fonético del destinatario con foneticaAplicada=true se tolera mid-línea (levenshtein vs encuesta)', () => {
  const response = buildResponse({
    foneticaAplicada: true,
    verse2: ['Después de un turno largo volvías feliz', 'Y siempre Yoelin cantaba al reír', 'Cada tropiezo lo hiciste sentir', 'Como un paso más hacia el porvenir'],
    chorus1: ['Yoelin, hoy te canto con todo mi amor', 'Gracias por darme siempre tu calor', 'Cada momento contigo brilla mejor', 'Eres mi orgullo y mi mayor honor'],
    chorus2: ['Yoelin, admiro tu fuerza y tu bondad', 'Marcaste mi vida con sinceridad', 'Nunca dudé de tu generosidad', 'Eres ejemplo puro de humanidad'],
  });
  const { failures } = hardValidate(response, "What's their name?: Johelyn");
  assert.equal(failures.filter((f) => f.startsWith('Nombre propio ausente')).length, 0, `fallos inesperados: ${failures.join(' | ')}`);
});

test('chequeo N: nombre propio tras puntuación de nueva oración mid-línea (¡/¿/.) no se marca como inventado', () => {
  const response = buildResponse({
    verse2: ['Después de un turno largo volvías feliz. Siempre reías', 'Sacabas fuerzas para hacernos reír', 'Cada tropiezo lo hiciste sentir', 'Como un paso más hacia el porvenir'],
  });
  const { failures } = hardValidate(response, SURVEY_SINGLE);
  assert.equal(failures.filter((f) => f.startsWith('Nombre propio ausente')).length, 0);
});
