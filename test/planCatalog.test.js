const test = require('node:test');
const assert = require('node:assert/strict');
const { FEATURES, getAcademyEntitlements, resolvePlanCode } = require('../services/planCatalog');

test('resuelve los tres planes comerciales canónicos', () => {
  assert.equal(resolvePlanCode({ plan_codigo: 'formacion' }), 'formacion');
  assert.equal(resolvePlanCode({ plan: 'Competencia' }), 'competencia');
  assert.equal(resolvePlanCode({ plan: 'Alto Rendimiento' }), 'alto_rendimiento');
});

test('el portal de apoderados nunca se incluye sin licencia adicional', () => {
  const premium = getAcademyEntitlements({ plan_codigo: 'alto_rendimiento', max_profesores: 15, licencia_apoderados: false });
  assert.equal(premium.features.includes(FEATURES.GUARDIANS), false);
  const licensed = getAcademyEntitlements({ plan_codigo: 'formacion', max_profesores: 2, licencia_apoderados: true });
  assert.equal(licensed.features.includes(FEATURES.GUARDIANS), true);
});

test('la prueba conserva todas las funciones base sin ampliar el cupo de profesores', () => {
  const trial = getAcademyEntitlements({ plan: 'Prueba 15 Días', plan_codigo: 'formacion', max_profesores: 2 });
  assert.equal(trial.plan.trial, true);
  assert.equal(trial.features.includes(FEATURES.ADVANCED_ANALYTICS), true);
  assert.equal(trial.limits.professors, 2);
});
