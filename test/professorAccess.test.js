const test = require('node:test');
const assert = require('node:assert/strict');
const { isProfessor, isAllowedProfessorRequest } = require('../middleware/professorAccess');

test('normaliza el rol profesor', () => {
  assert.equal(isProfessor({ rol: 'Profesor' }), true);
  assert.equal(isProfessor({ rol: 'director' }), false);
});

test('un profesor solo puede usar su portal y cambiar su contraseña', () => {
  assert.equal(isAllowedProfessorRequest({ originalUrl: '/api/profesores/me' }), true);
  assert.equal(isAllowedProfessorRequest({ originalUrl: '/api/profesores/me/categorias/1/asistencia?fecha=2026-08-14' }), true);
  assert.equal(isAllowedProfessorRequest({ originalUrl: '/api/cambiar-password' }), true);
  assert.equal(isAllowedProfessorRequest({ originalUrl: '/api/finanzas/resumen' }), false);
  assert.equal(isAllowedProfessorRequest({ originalUrl: '/api/jugadores' }), false);
});
