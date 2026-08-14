const test = require('node:test');
const assert = require('node:assert/strict');
const { getProfessorLimit } = require('../services/planLimits');

test('aplica los cupos de profesor según el plan', () => {
  assert.equal(getProfessorLimit({ plan: 'Prueba 15 Días' }), 2);
  assert.equal(getProfessorLimit({ plan: 'Formación' }), 2);
  assert.equal(getProfessorLimit({ plan: 'Competencia' }), 6);
  assert.equal(getProfessorLimit({ plan: 'Alto Rendimiento' }), 15);
});

test('respeta una ampliación manual válida de cupos', () => {
  assert.equal(getProfessorLimit({ plan: 'Formación', max_profesores: 4 }), 4);
  assert.equal(getProfessorLimit({ plan: 'Formación', max_profesores: 0 }), 2);
});
