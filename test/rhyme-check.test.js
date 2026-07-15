const test = require('node:test');
const assert = require('node:assert');
const { rhymeKey, wordsRhyme, analyzeSectionRhyme } = require('../lib/rhyme-check');

test('rhymeKey: extracción de asonancia y consonancia', () => {
  const k1 = rhymeKey('corazón');
  assert.equal(k1.asonante, 'o');
  assert.equal(k1.consonante, 'on');

  const k2 = rhymeKey('razón');
  assert.equal(k2.asonante, 'o');
  assert.equal(k2.consonante, 'on');

  const k3 = rhymeKey('historia'); // tónica o
  assert.equal(k3.asonante, 'o-a'); // o, ia -> o, a
});

test('wordsRhyme: rima consonante', () => {
  assert.equal(wordsRhyme('corazón', 'razón'), 'consonante');
  assert.equal(wordsRhyme('amar', 'cantar'), 'consonante');
});

test('wordsRhyme: rima asonante', () => {
  assert.equal(wordsRhyme('cocina', 'vida'), 'asonante'); // i-a
  assert.equal(wordsRhyme('catorce', 'noche'), 'asonante'); // o-e
  assert.equal(wordsRhyme('silencio', 'viento'), 'asonante'); // e-o
});

test('wordsRhyme: pares débiles que NO riman', () => {
  assert.equal(wordsRhyme('historia', 'ser'), null);
  assert.equal(wordsRhyme('trabajo', 'fuerza'), null);
  assert.equal(wordsRhyme('pase', 'día'), null);
});

test('analyzeSectionRhyme: identifica AABB', () => {
  const lines = [
    'tenía diecisiete y tú apenas catorce', // o-e
    'llegaste a darle luz a mi noche',     // o-e
    'la isla se quedó detrás en el silencio', // e-o
    'cruzamos hasta aquí venciendo al viento' // e-o
  ];
  const res = analyzeSectionRhyme(lines);
  assert.equal(res.scheme, 'AABB');
  assert.equal(res.rhymingPairs, 2);
  assert.equal(res.weakPairs.length, 0);
});

test('analyzeSectionRhyme: detecta pares débiles', () => {
  const lines = [
    'tenía diecisiete y tú apenas catorce', // o-e
    'llegaste a darle luz a mi noche',     // o-e
    'una gran historia', // o-i-a
    'para ser' // e
  ];
  const res = analyzeSectionRhyme(lines);
  // It will match AABB with 1 valid pair and 1 weak pair
  assert.equal(res.scheme, 'AABB');
  assert.equal(res.rhymingPairs, 1);
  assert.equal(res.weakPairs.length, 1);
  assert.ok(res.weakPairs[0].includes('historia'));
});
