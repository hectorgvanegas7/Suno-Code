const fs = require('fs');
const path = require('path');
const { convertJsonToMarkdown, hardValidate, parseSections } = require('./song-validate');
const { extractFirstNames, extractSurveyProperNouns } = require('./text-helpers');

const DEFAULT_MODEL = 'qwen3:14b';

function parseMarkdownToLetras(markdown) {
  const lines = markdown.split('\n').map(l => l.trim());
  const letras = {};
  let currentSection = null;

  for (const line of lines) {
    if (!line) continue;
    
    // Check if it's a section header like [Verse 1] or Verse 1:
    const sectionMatch = line.match(/^\[?(Verse \d+|Chorus \d+|Bridge|Outro)\]?:?$/i);
    if (sectionMatch) {
      // Normalize to exact casing required by the pipeline
      const normalizedHeader = sectionMatch[1]
        .replace(/verse/i, 'Verse')
        .replace(/chorus/i, 'Chorus')
        .replace(/bridge/i, 'Bridge')
        .replace(/outro/i, 'Outro');
      currentSection = normalizedHeader;
      letras[currentSection] = [];
    } else if (currentSection) {
      // Remove any backticks, markdown bolding, or quotes the LLM might have added to the line
      let cleanLine = line.replace(/^[-*]\s*/, '').replace(/[`*"]/g, '').trim();
      if (cleanLine) {
        letras[currentSection].push(cleanLine);
      }
    }
  }
  return letras;
}

async function optimizeLyricsPhonetics(parsedJson, surveyContent, options = {}) {
  const model = options.model || process.env.GUARDIA_MODEL || DEFAULT_MODEL;
  
  const firstNames = extractFirstNames(surveyContent);
  const surveyProperNouns = extractSurveyProperNouns(surveyContent);
  const properNounsContext = [...new Set([...firstNames, ...surveyProperNouns])].join(', ');

  const lyricsText = convertJsonToMarkdown(parsedJson.letras);

  const userPrompt = `Eres un corrector ortográfico automatizado. Toma la siguiente letra y corrige tildes, eñes y puntuación.
NO agregues notas, ni títulos, ni "QA Checklists". SOLO devuelve la letra corregida.
Nombres propios a proteger: [${properNounsContext}]

Letra a corregir:
${lyricsText}`;

  try {
    const response = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'user', content: userPrompt }
        ],
        stream: false,
        keep_alive: options.keepAlive ?? '5m',
        options: { temperature: 0.1 }
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    const correctedMarkdown = data.message?.content?.trim();
    console.log('--- OLLAMA RESPONSE ---');
    console.log(correctedMarkdown);
    console.log('-----------------------');

    if (!correctedMarkdown) {
      return { ok: false, error: 'Respuesta vacía de Ollama' };
    }

    const newLetras = parseMarkdownToLetras(correctedMarkdown);
    if (Object.keys(newLetras).length === 0) {
      return { ok: false, error: 'Ollama devolvió un formato irreconocible' };
    }

    const newJson = { ...parsedJson, letras: newLetras };
    const revalidated = hardValidate(JSON.stringify(newJson), surveyContent);
    
    if (!revalidated.valid) {
      return { ok: false, error: `Ollama rompió la estructura: ${revalidated.failures.join(', ')}`, original: true };
    }

    return { ok: true, parsedJson: revalidated.parsedJson };

  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = { optimizeLyricsPhonetics };
