const test = require('node:test');
const assert = require('node:assert/strict');
const { catalog, monthlyQuote, offer, PRICE_CLP, TOTAL_CLP, GUARDIAN_ADDON_CLP, GUARDIAN_TOTAL_CLP } = require('../services/deportivoOffer');
const { getAcademyEntitlements, FEATURES, guardianLicenseIsActive } = require('../services/planCatalog');
const { calculateGrossClp } = require('../services/billingCatalog');

test('plan único: $19.990 netos + 19% IVA, sin portal familiar incluido', () => {
  assert.equal(catalog.plans.length, 1);
  assert.equal(PRICE_CLP, 19990);
  assert.equal(TOTAL_CLP, 23788);
  assert.equal(calculateGrossClp({ priceClp: monthlyQuote.baseChargedNetClp }), TOTAL_CLP);
  assert.equal(monthlyQuote.guardians, false);
  assert.equal(monthlyQuote.guardianChargedGrossClp, 0);
  assert.equal(monthlyQuote.billingPeriodMonths, 1);
  assert.equal(monthlyQuote.promotionCode, null);
  assert.equal(monthlyQuote.chargedNetClp, PRICE_CLP);
  const access = getAcademyEntitlements({ plan: offer.name, plan_codigo: offer.code });
  assert.equal(access.features.includes(FEATURES.GUARDIANS), false);
  assert.equal(access.addOns.guardiansIncludedByPlan, false);
  assert.equal(access.pricing.guardiansClp, GUARDIAN_ADDON_CLP);
});

test('licencia de apoderados separada, activa solo con licencia vigente', () => {
  assert.equal(catalog.guardianAddon.included, false);
  assert.equal(GUARDIAN_ADDON_CLP, 15000);
  assert.equal(GUARDIAN_TOTAL_CLP, 17850);
  const without = getAcademyEntitlements({ plan: 'Prueba 15 Días', licencia_apoderados: false });
  assert.equal(without.features.includes(FEATURES.GUARDIANS), false);
  const withAddon = getAcademyEntitlements({ plan: offer.name, plan_codigo: offer.code, licencia_apoderados: true, guardian_license_ends_at: '2099-12-31' });
  assert.equal(withAddon.features.includes(FEATURES.GUARDIANS), true);
  assert.equal(withAddon.addOns.guardiansIncludedByPlan, false);
  assert.equal(guardianLicenseIsActive({ plan: offer.name, licencia_apoderados: true, guardian_license_ends_at: '2020-01-01' }, '2026-11-02'), false);
});
