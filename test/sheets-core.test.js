// test/sheets-core.test.js — Suite de regresión local para la parte pura de
// lib/sheets-core.js (decisión anti-duplicado vs. redo). A propósito NO llama
// a logSongToSheet() (toca Google Sheets real) — solo resolveSongIdCell(),
// que es pura (recibe las celdas existentes como parámetro). 100% offline.
// Corré con: npm test
//
// Bug real que arregla: un REDO reusa el mismo Song ID que la canción
// original, así que el anti-duplicado viejo (buscaba el Song ID tal cual)
// bloqueaba el registro de la sesión de trabajo del redo — se perdía el pago
// de esa sesión. Ver LESSONS.md / CLAUDE.md.
//
// El Song ID (col F) siempre queda limpio, sin sufijo "(redo N)" — esa marca
// vive solo en Remarks (col G, buildAutoRemark). Antes se sufijaba el propio
// Song ID, lo cual ensuciaba esa columna (pedido de Gabo 2026-07-05).

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSongIdCell, buildAutoRemark } = require('../lib/sheets-core');

test('resolveSongIdCell: no-redo con Song ID nuevo no bloquea', () => {
  assert.deepEqual(resolveSongIdCell([], 'abc-123', false), { blocked: false, cellValue: 'abc-123' });
});

test('resolveSongIdCell: no-redo con Song ID ya existente bloquea (duplicado real)', () => {
  const result = resolveSongIdCell(['abc-123'], 'abc-123', false);
  assert.equal(result.blocked, true);
});

test('resolveSongIdCell: redo con Song ID ya registrado (original) NO bloquea y NO sufija nada', () => {
  const result = resolveSongIdCell(['abc-123'], 'abc-123', true);
  assert.deepEqual(result, { blocked: false, cellValue: 'abc-123' });
});

test('resolveSongIdCell: segundo redo de la misma canción tampoco sufija, sigue limpio', () => {
  const result = resolveSongIdCell(['abc-123', 'abc-123'], 'abc-123', true);
  assert.deepEqual(result, { blocked: false, cellValue: 'abc-123' });
});

test('resolveSongIdCell: Song ID con caracteres especiales de regex no rompe nada', () => {
  const songId = 'a.b+c[1]';
  const result = resolveSongIdCell([songId], songId, true);
  assert.deepEqual(result, { blocked: false, cellValue: songId });
});

test('buildAutoRemark: isRedo = true devuelve "Redo Fix"', () => {
  assert.equal(buildAutoRemark(true), 'Redo Fix');
});

test('buildAutoRemark: isRedo = false devuelve string vacío', () => {
  assert.equal(buildAutoRemark(false), '');
});
