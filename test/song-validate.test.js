// test/song-validate.test.js — Suite de regresión local para hardValidate.
//
// 100% offline: no llama a ninguna API ni abre Chrome. Cubre bugs reales ya
// arreglados en LESSONS.md para que no vuelvan a colarse en un refactor futuro.
// Correr con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { hardValidate, validateContentForWrite, parseSections } = require('../lib/song-validate');

// Checklist con los 20 ítems reales del RESPONSE FORMAT (run.js), todos ✓
// salvo el condicional de multi-destinatario, que va en N/A por default
// (single-recipient es el caso común).
function buildChecklist({ multiRecipientLine = 'Destinatarios múltiples balanceados (si aplica): N/A' } = {}) {
  return [
    '**QA Checklist:**',
    '- 6 secciones en orden: ✓',
    '- 4 líneas por sección: ✓',
    '- Nombre = primera palabra Chorus 1 y 2: ✓',
    '- Nombre solo una vez por chorus: ✓',
    '- Nombre ausente en Verse 1: ✓',
    '- Chorus 1 ≠ Chorus 2: ✓',
    '- Verse 2 con escena concreta: ✓',
    '- Bridge con detalle más vulnerable: ✓',
    '- Nada inventado: ✓',
    '- Trato consistente en toda la letra: ✓',
    '- Números, meses y siglas completos: ✓',
    '- Título no cantable: ✓',
    '- Sin guiones largos / punto y coma / dos puntos: ✓',
    '- Sin líneas consecutivas con misma palabra inicial: ✓',
    '- Todas las líneas con sentido lógico: ✓',
    '- Estilo Suno incluye seseo + acento latinoamericano: ✓',
    '- Sin diálogos citados textualmente de la encuesta: ✓',
    `- ${multiRecipientLine}`,
    '- POV consistente / voz de Dios si es "para mí": ✓',
    '- Sin acróstico en el nombre: ✓',
  ].join('\n');
}

// Respuesta base 100% válida para un destinatario único ("Frank"), trato tú.
// Cada override reemplaza una sección puntual para probar un caso de fallo.
function buildResponse({
  trato = 'tú',
  estiloSuno = 'Balada, piano suave, Latin American Spanish, neutral accent, seseo',
  verse1 = ['Una tarde tranquila el cielo se abrió', 'Recuerdo esa risa que jamás cambió', 'El tiempo pasaba lento y sereno', 'Algo en mi pecho supo que eras bueno'],
  chorus1 = ['Frank, hoy te canto con todo mi amor', 'Gracias por darme siempre tu calor', 'Cada momento contigo brilla mejor', 'Eres mi orgullo y mi mayor honor'],
  chorus2 = ['Frank, admiro tu fuerza y tu bondad', 'Marcaste mi vida con sinceridad', 'Nunca dudé de tu generosidad', 'Sos ejemplo puro de humanidad',],
  verse2 = ['Después de un turno largo volvías feliz', 'Sacabas fuerzas para hacernos reír', 'Cada tropiezo lo hiciste sentir', 'Como un paso más hacia el porvenir'],
  bridge = ['Aquella noche me tomaste la mano', 'Y prometiste cuidar cada verano', 'Ese instante quedó grabado cercano', 'Fue la prueba de un amor soberano'],
  outro = ['Hoy te prometo un cariño sincero', 'Serás mi guía por todo el sendero', 'Con esta canción te digo primero', 'Te voy a amar por siempre entero'],
  checklist = buildChecklist(),
  preamble = '',
  advertencias = 'Ninguna',
} = {}) {
  const lyrics = [
    '[Verse 1]', ...verse1,
    '', '[Chorus 1]', ...chorus1,
    '', '[Verse 2]', ...verse2,
    '', '[Chorus 2]', ...chorus2,
    '', '[Bridge]', ...bridge,
    '', '[Outro]', ...outro,
  ].join('\n');

  return `${preamble}**Título:** Mi Canción Eterna
**Voz:** Masculina
**Trato:** ${trato}
**Estilo Suno:** ${estiloSuno}

---

${lyrics}

---

${checklist}

**Advertencias:** ${advertencias}`;
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

test('"N/A" en ítem condicional "(si aplica)" es válido, no cuenta como fallo', () => {
  const response = buildResponse({
    checklist: buildChecklist({ multiRecipientLine: 'Destinatarios múltiples balanceados (si aplica): N/A' }),
  });
  const { valid, failures } = hardValidate(response, SURVEY_SINGLE);
  assert.equal(valid, true, `no debería fallar por N/A condicional: ${failures.join(' | ')}`);
});

test('texto antes de "**Título:**" (preámbulo filtrado) falla la validación', () => {
  const response = buildResponse({
    preamble: 'I need to fully restructure this song because the original had extra sections.\n\n',
  });
  const { valid, failures } = hardValidate(response, SURVEY_SINGLE);
  assert.equal(valid, false);
  assert.ok(
    failures.some((f) => f.includes('texto antes de "**Título:**"')),
    `esperaba fallo de preámbulo, fallos: ${failures.join(' | ')}`
  );
});

test('línea de checklist marcada con "⚠️ REVISAR MANUALMENTE" en vez de ✗ cuenta como fallo', () => {
  const badChecklist = buildChecklist().replace(
    '- Sin diálogos citados textualmente de la encuesta: ✓',
    '- Sin diálogos citados textualmente de la encuesta: ⚠️ REVISAR MANUALMENTE (cita textual detectada)'
  );
  const response = buildResponse({ checklist: badChecklist });
  const { valid, failures } = hardValidate(response, SURVEY_SINGLE);
  assert.equal(valid, false);
  assert.ok(
    failures.some((f) => f.includes('Claude marcó fallo') && f.includes('REVISAR MANUALMENTE')),
    `esperaba fallo por símbolo no-✓, fallos: ${failures.join(' | ')}`
  );
});

test('cualquier línea de checklist sin ✓ literal (ni N/A condicional) cuenta como fallo', () => {
  const badChecklist = buildChecklist().replace(
    '- Título no cantable: ✓',
    '- Título no cantable: revisar de nuevo'
  );
  const response = buildResponse({ checklist: badChecklist });
  const { valid, failures } = hardValidate(response, SURVEY_SINGLE);
  assert.equal(valid, false);
  assert.ok(failures.some((f) => f.includes('Título no cantable')), `fallos: ${failures.join(' | ')}`);
});

test('extracción de nombres multi-destinatario: "Mis hijos Christopher y Soraya" no confunde "mis" con un nombre', () => {
  // Bug real (LESSONS.md): tomar la primera palabra del campo daba "Mis" como
  // nombre y el validador exigía que los choruses empezaran con "Mis".
  const chorus1 = ['Christopher, hoy quiero darte mi calor', 'Sos ejemplo de esfuerzo y de valor', 'Cada día me llenás de honor', 'Gracias por tu enorme corazón'];
  const chorus2 = ['Soraya, tu risa ilumina el hogar', 'Con tu fuerza me enseñaste a soñar', 'Nunca vas a dejar de brillar', 'Los dos son mi razón de celebrar'];
  const response = buildResponse({
    chorus1,
    chorus2,
    checklist: buildChecklist({ multiRecipientLine: 'Destinatarios múltiples balanceados (si aplica): ✓' }),
  });
  const { failures } = hardValidate(response, SURVEY_MULTI);
  const nameFailures = failures.filter((f) => f.toLowerCase().includes('mis') || f.includes('primera palabra'));
  assert.deepEqual(nameFailures, [], `no debería confundir "mis" con un nombre, fallos: ${nameFailures.join(' | ')}`);
  assert.ok(!failures.some((f) => f.includes('Christopher') && f.includes('no aparece')), 'Christopher debe reconocerse como presente');
  assert.ok(!failures.some((f) => f.includes('Soraya') && f.includes('no aparece')), 'Soraya debe reconocerse como presente');
});

test('nombre incorrecto en Chorus 1 (single-recipient) sí se detecta', () => {
  const response = buildResponse({
    chorus1: ['Roberto, hoy te canto con todo mi amor', 'Gracias por darme siempre tu calor', 'Cada momento contigo brilla mejor', 'Eres mi orgullo y mi mayor honor'],
  });
  const { valid, failures } = hardValidate(response, SURVEY_SINGLE);
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
  const brokenResponse = buildResponse().replace('[Bridge]\nAquella noche me tomaste la mano\nY prometiste cuidar cada verano\nEse instante quedó grabado cercano\nFue la prueba de un amor soberano\n\n', '');
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
  const truncated = '**Título:**';
  const { ok, failures } = validateContentForWrite(truncated);
  assert.equal(ok, false);
  assert.ok(failures.some((f) => f.includes('Falta **Título:**')), `fallos: ${failures.join(' | ')}`);
});

test('validateContentForWrite: contenido completo pasa', () => {
  const full = buildResponse();
  const tituloIndex = full.search(/\*\*Título:\*\*/i);
  const checklistIndex = full.search(/\*\*QA Checklist:\*\*/i);
  const lyricsContent = full.slice(tituloIndex, checklistIndex);
  const { ok, failures } = validateContentForWrite(lyricsContent);
  assert.equal(ok, true, `fallos: ${failures.join(' | ')}`);
});

test('parseSections respeta el orden y separa líneas correctamente', () => {
  const { sections, errors } = parseSections(buildResponse());
  assert.deepEqual(errors, []);
  assert.equal(sections['Verse 1'].length, 4);
  assert.equal(sections['Chorus 1'][0].startsWith('Frank'), true);
});
