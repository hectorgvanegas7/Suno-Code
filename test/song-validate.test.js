// test/song-validate.test.js — Suite de regresión local para hardValidate.
//
// 100% offline: no llama a ninguna API ni abre Chrome. Cubre bugs reales ya
// arreglados en LESSONS.md para que no vuelvan a colarse en un refactor futuro.
// Correr con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { hardValidate, validateContentForWrite, parseSections, isSafeToPatch } = require('../lib/song-validate');

function buildResponse({
  trato = 'tú',
  estiloSuno = 'Balada, piano suave, Latin American Spanish, neutral accent, seseo',
  verse1 = ['Una tarde tranquila el cielo se abrió', 'Recuerdo esa risa que jamás cambió', 'El tiempo pasaba lento y sereno', 'Algo en mi pecho supo que eras bueno'],
  chorus1 = ['Frank, hoy te canto con todo mi amor', 'Gracias por darme siempre tu calor', 'Cada momento contigo brilla mejor', 'Eres mi orgullo y mi mayor honor'],
  chorus2 = ['Frank, admiro tu fuerza y tu bondad', 'Marcaste mi vida con sinceridad', 'Nunca dudé de tu generosidad', 'Sos ejemplo puro de humanidad',],
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
    "sin_acrostico": true
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
  const chorus1 = ['Christopher, hoy quiero darte mi calor', 'Sos ejemplo de esfuerzo y de valor', 'Cada día me llenás de honor', 'Gracias por tu enorme corazón'];
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
    chorus1: ['Christopher y Soraya, los dos son mi calor', 'Sos ejemplo de esfuerzo y de valor', 'Cada día me llenás de honor', 'Gracias por su enorme corazón'],
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
    chorus2: ['María, admiro tu fuerza y tu bondad', 'Marcaste mi vida con sinceridad', 'Nunca dudé de tu generosidad', 'Sos ejemplo puro de humanidad'],
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
    chorus2: ['Yeováni, admiro tu fuerza y tu bondad', 'Marcaste mi vida con sinceridad', 'Nunca dudé de tu generosidad', 'Sos ejemplo puro de humanidad'],
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
    chorus2: ['Aal, admiro tu fuerza y tu bondad', 'Marcaste mi vida con sinceridad', 'Nunca dudé de tu generosidad', 'Sos ejemplo puro de humanidad'],
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
    chorus2: ['Aal, admiro tu fuerza y tu bondad', 'Marcaste mi vida con sinceridad', 'Nunca dudé de tu generosidad', 'Sos ejemplo puro de humanidad'],
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
    chorus2: ['Aal, admiro tu fuerza y tu bondad', 'Marcaste mi vida con sinceridad', 'Nunca dudé de tu generosidad', 'Sos ejemplo puro de humanidad'],
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
