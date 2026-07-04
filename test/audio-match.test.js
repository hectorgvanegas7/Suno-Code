// test/audio-match.test.js — Suite de regresión local para titleMatchScore
// (lib/audio-match.js).
//
// 100% offline: no toca el filesystem real ni Chrome. Corré con: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { titleMatchScore, normalize } = require('../lib/audio-match');

test('titleMatchScore: título normal matchea contra el nombre de archivo esperado', () => {
  const score = titleMatchScore(normalize('El Vestido Rojo'), normalize('El Vestido Rojo B'));
  assert.equal(score, 1);
});

test('titleMatchScore: título compuesto ENTERAMENTE por palabras cortas (≤2 chars) no da 0 siempre', () => {
  // Bug real (2026-07-04, ver LESSONS.md): el filtro de palabras >2 caracteres
  // dejaba `words` vacío para títulos como "Fe" o "A ti", y el score daba 0
  // sin importar el archivo — un título corto nunca podía matchear nada.
  const score = titleMatchScore(normalize('Fe'), normalize('Fe B'));
  assert.ok(score > 0, `esperaba score > 0 para título corto, dio ${score}`);
});

test('titleMatchScore: "A ti" (todas las palabras ≤2 chars) matchea el archivo correcto', () => {
  const score = titleMatchScore(normalize('A ti'), normalize('A ti A'));
  assert.ok(score > 0, `esperaba score > 0, dio ${score}`);
});

test('titleMatchScore: título corto no matchea un archivo de una canción distinta', () => {
  const score = titleMatchScore(normalize('Fe'), normalize('Nuestro Pacto Eterno B'));
  assert.equal(score, 0);
});

test('titleMatchScore: título vacío da 0 sin lanzar', () => {
  const score = titleMatchScore(normalize(''), normalize('Cualquier Archivo'));
  assert.equal(score, 0);
});
