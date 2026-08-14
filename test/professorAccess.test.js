const test = require('node:test');
const assert = require('node:assert/strict');
const { isProfessor, isGuardian, isAllowedProfessorRequest, isAllowedGuardianRequest } = require('../middleware/professorAccess');

test('normaliza el rol profesor', () => {
  assert.equal(isProfessor({ rol: 'Profesor' }), true);
  assert.equal(isProfessor({ rol: 'director' }), false);
});

test('un apoderado solo puede usar su portal privado', () => {
  assert.equal(isGuardian({ rol: 'Apoderado' }), true);
  assert.equal(isAllowedGuardianRequest({ originalUrl: '/api/apoderados/me' }), true);
  assert.equal(isAllowedGuardianRequest({ originalUrl: '/api/apoderados/me?seccion=pagos' }), true);
  assert.equal(isAllowedGuardianRequest({ originalUrl: '/api/cambiar-password' }), true);
  assert.equal(isAllowedGuardianRequest({ originalUrl: '/api/jugadores' }), false);
  assert.equal(isAllowedGuardianRequest({ originalUrl: '/api/finanzas/resumen' }), false);
});

test('un profesor solo puede usar su portal y cambiar su contraseña', () => {
  assert.equal(isAllowedProfessorRequest({ originalUrl: '/api/profesores/me' }), true);
  assert.equal(isAllowedProfessorRequest({ originalUrl: '/api/profesores/me/categorias/1/asistencia?fecha=2026-08-14' }), true);
  assert.equal(isAllowedProfessorRequest({ originalUrl: '/api/cambiar-password' }), true);
  assert.equal(isAllowedProfessorRequest({ originalUrl: '/api/finanzas/resumen' }), false);
  assert.equal(isAllowedProfessorRequest({ originalUrl: '/api/jugadores' }), false);
});
