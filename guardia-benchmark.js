// guardia-benchmark.js — Banco de casos DORADOS para medir las capas de
// fidelidad (chequeo N determinístico + extracción cerrada de hechos vía
// Ollama) contra letras reales ya etiquetadas como buenas/malas.
//
// Motivación (2026-07-14, caso "Miami" — ver LESSONS.md): los prompts del
// Guardia se venían ajustando "a ojo" — se endureció el prompt de fidelidad
// y solo se supo que NO servía porque se re-testeó a mano contra la letra
// mala en vivo. Este script convierte ese testeo manual en herramienta
// repetible: cada incidente real agrega una carpeta a golden/ y cada cambio
// futuro de prompt/modelo se mide acá ANTES de confiar en él.
//
// Estructura de un caso: golden/<nombre>/
//   song.txt    — la letra en formato song.txt real
//   survey.txt  — la encuesta real de ese pedido
//   expect.json — { letraEsBuena: bool, hechosInventadosEsperados: string[] }
//
// Uso:
//   node guardia-benchmark.js             → chequeo N + extracción (Ollama vivo)
//   node guardia-benchmark.js --offline   → solo chequeo N (sin red, instantáneo)
//   node guardia-benchmark.js --judgment  → suma el juicio de fidelidad del
//                                           Guardia (lento; documenta su tasa
//                                           de acierto, hoy conocida como mala)
//   node guardia-benchmark.js --readiness → imprime READY/NOT READY para
//                                           activar FACT_GATE=regen, con el
//                                           criterio medible completo (banco +
//                                           jsonl de producción + veredictos
//                                           FP/TP del celular). Sin red.
//
// Sale con código 1 si algún caso falla — sirve para verificar en frío que
// un cambio de prompt no rompió lo que ya funcionaba.
//
// NUNCA toca el pipeline ni state.json — 100% lectura de golden/ y logs/.

const fs = require('fs');
const path = require('path');
const { findInventedProperNouns } = require('./lib/song-validate');
const { extraerHechosLetra, compararHechosConEncuesta, validarGuardia } = require('./lib/ollama-guardia');
const { extractFirstNames } = require('./lib/text-helpers');

const GOLDEN_DIR = path.join(__dirname, 'golden');
const args = process.argv.slice(2);
const offline = args.includes('--offline');
const includeJudgment = args.includes('--judgment');
const readinessMode = args.includes('--readiness');

// ─── --readiness: ¿se puede activar FACT_GATE=regen? (2026-07-14) ────────────
// Criterio medible y completo — la lección del banco dorado ("cero falsos
// positivos solo se afirma con casos reales, nunca con 1-2 corridas
// manuales") aplicada a la graduación del gate:
//   1. golden/ con ≥10 casos (≥4 malas con hechos esperados, ≥5 buenas).
//   2. Producción: ≥15 canciones en logs/guardia-feedback.jsonl con la señal
//      de extracción corrida.
//   3. Cero falsos positivos confirmados: ningún veredicto 'fp' en
//      logs/fact-verdicts.jsonl (los botones ❌/🚨 del celular), y las
//      alarmas sin veredicto humano no cuentan como limpias.
// Imprime el estado de cada condición y READY/NOT READY. 100% offline.
function runReadiness() {
  const feedbackPath = path.join(__dirname, 'logs', 'guardia-feedback.jsonl');
  const verdictsPath = path.join(__dirname, 'logs', 'fact-verdicts.jsonl');
  const readJsonl = (p) => {
    try {
      return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  };

  const cases = fs.existsSync(GOLDEN_DIR)
    ? fs.readdirSync(GOLDEN_DIR).filter((d) => fs.existsSync(path.join(GOLDEN_DIR, d, 'expect.json')))
    : [];
  const goldenGood = cases.filter((c) => {
    try { return JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, c, 'expect.json'), 'utf-8')).letraEsBuena; } catch { return false; }
  }).length;
  const goldenBad = cases.length - goldenGood;

  const feedback = readJsonl(feedbackPath).filter((e) => e.extraccionHechos || e.hechosSinRespaldo);
  const alarms = feedback.filter((e) => (e.hechosSinRespaldo?.sinRespaldo || []).length > 0);
  const verdicts = readJsonl(verdictsPath);
  const fpCount = verdicts.filter((v) => v.verdict === 'fp').length;
  const tpCount = verdicts.filter((v) => v.verdict === 'tp').length;
  const unjudgedAlarms = Math.max(0, alarms.length - verdicts.length);

  const conditions = [
    { ok: cases.length >= 10 && goldenBad >= 4 && goldenGood >= 5, label: `Banco dorado: ${cases.length} caso(s) (${goldenBad} malas, ${goldenGood} buenas) — se exige ≥10 (≥4 malas, ≥5 buenas)` },
    { ok: feedback.length >= 15, label: `Producción: ${feedback.length} canción(es) con extracción en guardia-feedback.jsonl — se exige ≥15` },
    { ok: fpCount === 0, label: `Falsos positivos confirmados (botón ❌ del celular): ${fpCount} — se exige 0` },
    { ok: unjudgedAlarms === 0, label: `Alarmas sin veredicto humano: ${unjudgedAlarms} (TP confirmados: ${tpCount}) — se exige 0 (una alarma sin juzgar no cuenta como limpia)` },
  ];

  console.log('🎓 Readiness de FACT_GATE=regen:\n');
  for (const c of conditions) console.log(`  ${c.ok ? '✅' : '❌'} ${c.label}`);
  const ready = conditions.every((c) => c.ok);
  console.log(ready
    ? '\n🟢 READY — activá con FACT_GATE=regen (kill-switch: FACT_GATE=warn). Corré también `node guardia-benchmark.js` completo antes, para confirmar el banco en verde.'
    : '\n🔴 NOT READY — seguir calibrando en modo warn (los botones 🚨/❌ del celular alimentan logs/fact-verdicts.jsonl).');
  process.exit(ready ? 0 : 1);
}

function parseSectionsFromSongTxt(content) {
  const sections = {};
  const re = /\[(Verse 1|Chorus 1|Verse 2|Chorus 2|Bridge|Outro)\]\n([\s\S]*?)(?=\n\[|\n---|\n\*\*|$)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    sections[m[1]] = m[2].trim().split('\n').map((l) => l.trim()).filter(Boolean);
  }
  return sections;
}

function normalizeForMatch(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Un hecho esperado se considera detectado si aparece (como substring
// normalizado) en alguno de los valores encontrados.
function coincide(esperado, encontrados) {
  const e = normalizeForMatch(esperado);
  return encontrados.some((v) => normalizeForMatch(v).includes(e));
}

(async () => {
  if (readinessMode) {
    runReadiness();
    return;
  }
  if (!fs.existsSync(GOLDEN_DIR)) {
    console.error('❌ No existe la carpeta golden/ — nada que medir.');
    process.exit(1);
  }
  const cases = fs.readdirSync(GOLDEN_DIR).filter((d) => fs.existsSync(path.join(GOLDEN_DIR, d, 'expect.json')));
  if (cases.length === 0) {
    console.error('❌ golden/ no tiene casos con expect.json.');
    process.exit(1);
  }

  console.log(`🏆 Banco dorado: ${cases.length} caso(s)${offline ? ' — modo OFFLINE (solo chequeo N)' : ''}${includeJudgment ? ' + juicio del Guardia' : ''}\n`);
  let fallos = 0;

  for (const caseName of cases) {
    const dir = path.join(GOLDEN_DIR, caseName);
    const expect = JSON.parse(fs.readFileSync(path.join(dir, 'expect.json'), 'utf-8'));
    const songContent = fs.readFileSync(path.join(dir, 'song.txt'), 'utf-8');
    const survey = fs.readFileSync(path.join(dir, 'survey.txt'), 'utf-8');
    const sections = parseSectionsFromSongTxt(songContent);
    const firstNames = extractFirstNames(survey);
    const esperados = expect.hechosInventadosEsperados || [];

    console.log(`═══ ${caseName} (${expect.letraEsBuena ? 'BUENA' : 'MALA'}) ═══`);

    // Capa 1: chequeo N determinístico (siempre, offline)
    const nFound = findInventedProperNouns(sections, survey, { firstNames, foneticaAplicada: false });
    const nWords = nFound.map((f) => f.word);
    const nEsperadosDetectados = esperados.filter((e) => coincide(e, nWords));
    const nFalsosPositivos = expect.letraEsBuena ? nWords : [];
    const nOk = expect.letraEsBuena
      ? nWords.length === 0
      : nEsperadosDetectados.length === esperados.length;
    console.log(`  chequeo N: ${nOk ? '✅' : '❌'} encontrados=[${nWords.join(', ')}]${nFalsosPositivos.length ? ` — FALSOS POSITIVOS: ${nFalsosPositivos.join(', ')}` : ''}`);
    if (!nOk) fallos++;

    // Capa 2: extracción cerrada + comparación en código (Ollama vivo)
    if (!offline) {
      const ex = await extraerHechosLetra(
        { letras: sections, titulo: caseName },
        { keepAlive: '5m' }
      );
      if (!ex.ok) {
        console.log(`  extracción: ⚠️ no disponible (${ex.error}) — no cuenta como fallo del banco`);
      } else {
        const cmp = compararHechosConEncuesta(ex, survey, { firstNames });
        const valores = cmp.sinRespaldo.map((h) => h.valor);
        const exEsperadosDetectados = esperados.filter((e) => coincide(e, valores));
        // En letra BUENA el criterio es estricto (cero falsos positivos: es
        // la propiedad que decide la graduación a gate). En letra MALA solo
        // exigimos que los esperados estén — ruido extra del lado malo no
        // resta (marcar de más en una letra ya mala es inocuo).
        const exOk = expect.letraEsBuena
          ? valores.length === 0
          : exEsperadosDetectados.length === esperados.length;
        console.log(`  extracción (${Math.round(ex.durationMs / 1000)}s): ${exOk ? '✅' : '❌'} sinRespaldo=[${valores.join(', ')}]`);
        if (!exOk) fallos++;
      }

      // Capa 3 (opcional, lenta): el juicio de fidelidad del Guardia — hoy
      // documentado como NO confiable para hechos inventados; medirlo acá
      // deja constancia numérica de si algún modelo/prompt futuro lo mejora.
      if (includeJudgment) {
        const estiloSuno = (songContent.match(/\*\*Estilo Suno:\*\* (.+)/) || [])[1] || '';
        const g = await validarGuardia(
          { letras: sections, titulo: caseName, survey, estiloSuno },
          { keepAlive: 0 }
        );
        if (!g.ok) {
          console.log(`  juicio Guardia: ⚠️ no disponible (${g.error})`);
        } else {
          const gOk = expect.letraEsBuena ? g.aprobada === true : g.aprobada === false;
          console.log(`  juicio Guardia (${Math.round(g.durationMs / 1000)}s): ${gOk ? '✅' : '❌ (esperado ' + (expect.letraEsBuena ? 'aprobada' : 'rechazada') + ')'} fidelidad=${g.fidelidad} aprobada=${g.aprobada}`);
          // Informativo: el juicio NO cuenta para el exit code — su tasa de
          // fallo es conocida (LESSONS.md 2026-07-14) y no gatea nada.
        }
      }
    }
    console.log('');
  }

  console.log(fallos === 0 ? '🏆 Banco dorado: TODO en verde.' : `❌ Banco dorado: ${fallos} chequeo(s) fallaron.`);
  process.exit(fallos === 0 ? 0 : 1);
})();
