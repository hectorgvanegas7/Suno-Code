const { optimizeLyricsPhonetics } = require('../lib/ollama-corrector');
const assert = require('assert');

async function runTest() {
  console.log('Running optimizeLyricsPhonetics test...');
  const surveyContent = "Nombre: Antonio\nEstilo: Balada triste\nLugar: Madrid";
  const parsedJson = {
    letras: {
      "[Verse 1]": "una cancion muy triste\nAntonio nacio en Madrid el ano pasado",
      "[Chorus]": "y el corazon se me rompio\npero la vida sigue"
    }
  };

  const result = await optimizeLyricsPhonetics(parsedJson, surveyContent);
  if (!result.ok) {
    console.error('Test falló:', result.error);
    process.exit(1);
  }

  const { letras } = result.parsedJson;
  const verse1 = letras["[Verse 1]"];
  const chorus = letras["[Chorus]"];

  console.log('Result:', letras);

  assert.ok(verse1.includes('canción'), 'Debe tener tilde en canción');
  assert.ok(verse1.includes('nació'), 'Debe tener tilde en nació');
  assert.ok(verse1.includes('Antonio'), 'Debe respetar Antonio');
  assert.ok(verse1.includes('Madrid'), 'Debe respetar Madrid');
  assert.ok(verse1.includes('año'), 'Debe corregir ano a año');

  assert.ok(chorus.includes('corazón'), 'Debe tener tilde en corazón');
  assert.ok(chorus.includes('rompió'), 'Debe tener tilde en rompió');

  console.log('✅ All tests passed!');
}

runTest().catch(console.error);
