const test = require('node:test');
const assert = require('node:assert/strict');
const { FEATURES, getAcademyEntitlements, resolvePlanCode } = require('../services/planCatalog');

test('resuelve los tres planes comerciales canónicos', () => {
  assert.equal(resolvePlanCode({ plan_codigo: 'formacion' }), 'formacion');
  assert.equal(resolvePlanCode({ plan: 'Competencia' }), 'competencia');
  assert.equal(resolvePlanCode({ plan: 'Alto Rendimiento' }), 'alto_rendimiento');
});

test('el portal de apoderados está incluido en todos los planes', () => {
  for (const plan_codigo of ['formacion', 'competencia', 'alto_rendimiento']) {
    const entitlements = getAcademyEntitlements({ plan_codigo, licencia_apoderados: false });
    assert.equal(entitlements.features.includes(FEATURES.GUARDIANS), true);
    assert.equal(entitlements.addOns.guardians, true);
    assert.equal(entitlements.pricing.guardiansClp, 0);
  }
});

test('todos los planes tienen radar, pero solo Competencia y Alto Rendimiento personalizan criterios', () => {
  const formation = getAcademyEntitlements({ plan_codigo: 'formacion' });
  const competition = getAcademyEntitlements({ plan_codigo: 'competencia' });
  const highPerformance = getAcademyEntitlements({ plan_codigo: 'alto_rendimiento' });

  for (const entitlements of [formation, competition, highPerformance]) {
    assert.equal(entitlements.features.includes(FEATURES.EVALUATIONS), true);
  }
  assert.equal(formation.features.includes(FEATURES.CUSTOM_EVALUATION_CRITERIA), false);
  assert.equal(competition.features.includes(FEATURES.CUSTOM_EVALUATION_CRITERIA), true);
  assert.equal(highPerformance.features.includes(FEATURES.CUSTOM_EVALUATION_CRITERIA), true);
});

test('la prueba Full habilita todas las funciones y capacidad premium', () => {
  const trial = getAcademyEntitlements({ plan: 'Prueba 15 Días', plan_codigo: 'formacion', max_profesores: 2 });
  assert.equal(trial.plan.trial, true);
  assert.equal(trial.features.includes(FEATURES.ADVANCED_ANALYTICS), true);
  assert.equal(trial.features.includes(FEATURES.GUARDIANS), true);
  assert.equal(trial.features.includes(FEATURES.WHATSAPP_GROUPS), true);
  assert.equal(trial.features.includes(FEATURES.CUSTOM_EVALUATION_CRITERIA), true);
  assert.equal(trial.limits.professors, 30);
  assert.equal(trial.limits.players, null);
  assert.equal(trial.limits.sites, null);
  assert.equal(trial.limits.branches, null);
});

test('torneos son base y las funciones avanzadas diferencian los planes', () => {
  const formation = getAcademyEntitlements({ plan_codigo: 'formacion' });
  const competition = getAcademyEntitlements({ plan_codigo: 'competencia' });
  const highPerformance = getAcademyEntitlements({ plan_codigo: 'alto_rendimiento' });

  assert.equal(formation.features.includes(FEATURES.TOURNAMENTS), true);
  assert.equal(competition.features.includes(FEATURES.TOURNAMENTS), true);
  assert.equal(highPerformance.features.includes(FEATURES.TOURNAMENTS), true);

  assert.equal(formation.features.includes(FEATURES.WHATSAPP_GROUPS), false);
  assert.equal(competition.features.includes(FEATURES.WHATSAPP_GROUPS), true);
  assert.equal(competition.features.includes(FEATURES.MEDICAL), false);
  assert.equal(highPerformance.features.includes(FEATURES.MEDICAL), true);

  assert.deepEqual(
    [formation.limits.players, competition.limits.players, highPerformance.limits.players],
    [100, 300, null],
  );
  assert.deepEqual(
    [formation.limits.sites, competition.limits.sites, highPerformance.limits.sites],
    [1, 2, null],
  );
  assert.deepEqual(
    [formation.limits.branches, competition.limits.branches, highPerformance.limits.branches],
    [1, 2, null],
  );
});
