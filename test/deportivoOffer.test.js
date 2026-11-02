const test = require('node:test');
const assert = require('node:assert/strict');
const { catalog, monthlyQuote, offer, PRICE_CLP } = require('../services/deportivoOffer');
const { getAcademyEntitlements, FEATURES } = require('../services/planCatalog');
const { calculateGrossClp } = require('../services/billingCatalog');

test('única mensualidad con IVA y portal familiar incluidos', () => {
  assert.equal(catalog.plans.length, 1);
  assert.equal(PRICE_CLP, 19990);
  assert.equal(calculateGrossClp({ priceClp: monthlyQuote.baseChargedNetClp }), PRICE_CLP);
  assert.equal(monthlyQuote.guardianChargedGrossClp, 0);
  assert.equal(monthlyQuote.billingPeriodMonths, 1);
  assert.equal(monthlyQuote.promotionCode, null);
  const access = getAcademyEntitlements({ plan: offer.name, plan_codigo: offer.code });
  assert.deepEqual(new Set(access.features), new Set(Object.values(FEATURES)));
  assert.equal(access.addOns.guardiansIncludedByPlan, true);
});
