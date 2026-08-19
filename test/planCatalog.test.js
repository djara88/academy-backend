const test = require('node:test');
const assert = require('node:assert/strict');
const { FEATURES, GUARDIAN_ADDON_CLP, getAcademyEntitlements, resolvePlanCode } = require('../services/planCatalog');

test('resuelve los tres planes comerciales canónicos', () => {
  assert.equal(resolvePlanCode({ plan_codigo: 'formacion' }), 'formacion');
  assert.equal(resolvePlanCode({ plan: 'Competencia' }), 'competencia');
  assert.equal(resolvePlanCode({ plan: 'Alto Rendimiento' }), 'alto_rendimiento');
});

test('Apoderados PRO es un complemento pagado en planes activos', () => {
  for (const plan_codigo of ['formacion', 'competencia', 'alto_rendimiento']) {
    const withoutAddon = getAcademyEntitlements({ plan_codigo, licencia_apoderados: false });
    assert.equal(withoutAddon.features.includes(FEATURES.GUARDIANS), false);
    assert.equal(withoutAddon.addOns.guardians, false);
    assert.equal(withoutAddon.pricing.guardiansClp, GUARDIAN_ADDON_CLP);

    const withAddon = getAcademyEntitlements({ plan_codigo, licencia_apoderados: true, guardian_license_ends_at: '2099-12-31' });
    assert.equal(withAddon.features.includes(FEATURES.GUARDIANS), true);
    assert.equal(withAddon.addOns.guardians, true);
    assert.equal(withAddon.addOns.guardiansIncludedByPlan, false);
  }
  assert.equal(GUARDIAN_ADDON_CLP, 15000);
});

test('una licencia familiar vencida deja de habilitar el portal', () => {
  const entitlements = getAcademyEntitlements({ plan_codigo: 'competencia', licencia_apoderados: true, guardian_license_ends_at: '2020-01-01' });
  assert.equal(entitlements.features.includes(FEATURES.GUARDIANS), false);
  assert.equal(entitlements.addOns.guardians, false);
});

test('todos los planes tienen radar y catálogo estándar; solo Competencia y Alto Rendimiento personalizan', () => {
  const formation = getAcademyEntitlements({ plan_codigo: 'formacion' });
  const competition = getAcademyEntitlements({ plan_codigo: 'competencia' });
  const highPerformance = getAcademyEntitlements({ plan_codigo: 'alto_rendimiento' });
  for (const entitlements of [formation, competition, highPerformance]) assert.equal(entitlements.features.includes(FEATURES.EVALUATIONS), true);
  assert.equal(formation.features.includes(FEATURES.CUSTOM_EVALUATION_CRITERIA), false);
  assert.equal(formation.features.includes(FEATURES.CUSTOM_RECOGNITIONS), false);
  assert.equal(competition.features.includes(FEATURES.CUSTOM_EVALUATION_CRITERIA), true);
  assert.equal(competition.features.includes(FEATURES.CUSTOM_RECOGNITIONS), true);
  assert.equal(highPerformance.features.includes(FEATURES.CUSTOM_EVALUATION_CRITERIA), true);
  assert.equal(highPerformance.features.includes(FEATURES.CUSTOM_RECOGNITIONS), true);
});

test('la prueba Full habilita Apoderados PRO y capacidad premium', () => {
  const trial = getAcademyEntitlements({ plan: 'Prueba 15 Días', plan_codigo: 'formacion', max_profesores: 2, licencia_apoderados: false, trial_ends_at: '2099-12-31' });
  assert.equal(trial.plan.trial, true);
  assert.equal(trial.features.includes(FEATURES.ADVANCED_ANALYTICS), true);
  assert.equal(trial.features.includes(FEATURES.GUARDIANS), true);
  assert.equal(trial.features.includes(FEATURES.WHATSAPP_GROUPS), true);
  assert.equal(trial.features.includes(FEATURES.CUSTOM_EVALUATION_CRITERIA), true);
  assert.equal(trial.features.includes(FEATURES.CUSTOM_RECOGNITIONS), true);
  assert.equal(trial.features.includes(FEATURES.TOURNAMENTS), true);
  assert.equal(trial.features.includes(FEATURES.MATCHES), true);
  assert.equal(trial.addOns.guardiansIncludedByTrial, true);
  assert.equal(trial.limits.professors, 30);
  assert.equal(trial.limits.players, null);
  assert.equal(trial.limits.sites, null);
  assert.equal(trial.limits.branches, null);
});

test('competencias y resultados están disponibles desde Competencia', () => {
  const formation = getAcademyEntitlements({ plan_codigo: 'formacion' });
  const competition = getAcademyEntitlements({ plan_codigo: 'competencia' });
  const highPerformance = getAcademyEntitlements({ plan_codigo: 'alto_rendimiento' });
  assert.equal(formation.features.includes(FEATURES.TOURNAMENTS), false);
  assert.equal(formation.features.includes(FEATURES.MATCHES), false);
  assert.equal(competition.features.includes(FEATURES.TOURNAMENTS), true);
  assert.equal(competition.features.includes(FEATURES.MATCHES), true);
  assert.equal(highPerformance.features.includes(FEATURES.TOURNAMENTS), true);
  assert.equal(highPerformance.features.includes(FEATURES.MATCHES), true);
  assert.equal(formation.features.includes(FEATURES.WHATSAPP_GROUPS), false);
  assert.equal(competition.features.includes(FEATURES.WHATSAPP_GROUPS), true);
  assert.equal(competition.features.includes(FEATURES.MEDICAL), false);
  assert.equal(highPerformance.features.includes(FEATURES.MEDICAL), true);
  assert.deepEqual([formation.limits.players, competition.limits.players, highPerformance.limits.players], [100, 300, null]);
  assert.deepEqual([formation.limits.sites, competition.limits.sites, highPerformance.limits.sites], [1, 2, null]);
  assert.deepEqual([formation.limits.branches, competition.limits.branches, highPerformance.limits.branches], [1, 2, null]);
});
