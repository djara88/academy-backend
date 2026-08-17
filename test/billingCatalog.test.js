const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateGrossClp, getBillingPlan, getBillingQuote, guardianAddonQuote, GUARDIAN_ADDON_CLP } = require('../services/billingCatalog');

test('calcula IVA chileno y recargo de Apoderados PRO', () => {
  assert.equal(GUARDIAN_ADDON_CLP, 15000);
  assert.equal(calculateGrossClp({ priceClp: 59000 }), 70210);
  assert.equal(calculateGrossClp({ priceClp: 59000, guardians: true }), 88060);
});

test('catálogo comercial coincide con precios y cupos aprobados', () => {
  assert.deepEqual(
    ['formacion', 'competencia', 'alto_rendimiento'].map((code) => [
      getBillingPlan(code).priceClp,
      getBillingPlan(code).founderPriceClp,
      getBillingPlan(code).professorLimit,
      getBillingPlan(code).playerLimit,
    ]),
    [[59000, 49000, 3, 100], [99000, 79000, 10, 300], [149000, 119000, 30, null]],
  );
});

test('anual cobra diez meses y habilita doce', () => {
  const quote = getBillingQuote({ planCode: 'competencia', billingCycle: 'annual' });
  assert.equal(quote.chargedNetClp, 990000);
  assert.equal(quote.regularNetClp, 1188000);
  assert.equal(quote.billingPeriodMonths, 12);
  assert.equal(quote.monthlyEquivalentNetClp, 82500);
});

test('Apoderados PRO anual cobra diez meses y dura doce', () => {
  const addon = guardianAddonQuote('annual');
  assert.equal(addon.chargedNetClp, 150000);
  assert.equal(addon.regularNetClp, 180000);
  assert.equal(addon.billingPeriodMonths, 12);
  const quote = getBillingQuote({ planCode: 'formacion', billingCycle: 'annual', guardians: true });
  assert.equal(quote.chargedNetClp, 740000);
  assert.equal(quote.guardianChargedNetClp, 150000);
});

test('fundador usa precio especial mensual y add-on conserva precio lista', () => {
  const quote = getBillingQuote({ planCode: 'alto_rendimiento', promotionCode: 'founder', guardians: true });
  assert.equal(quote.baseChargedNetClp, 119000);
  assert.equal(quote.guardianChargedNetClp, 15000);
  assert.equal(quote.chargedNetClp, 134000);
  assert.equal(quote.billingCycle, 'monthly');
  assert.throws(
    () => getBillingQuote({ planCode: 'formacion', billingCycle: 'annual', promotionCode: 'founder' }),
    (error) => error.code === 'PROMOTION_NOT_STACKABLE',
  );
});
