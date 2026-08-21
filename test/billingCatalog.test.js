const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateGrossClp, getBillingPlan, getBillingQuote, guardianAddonQuote, GUARDIAN_ADDON_CLP } = require('../services/billingCatalog');

test('calcula IVA chileno y recargo de Apoderados PRO', () => {
  assert.equal(GUARDIAN_ADDON_CLP, 15000);
  assert.equal(calculateGrossClp({ priceClp: 44990 }), 53538);
  assert.equal(calculateGrossClp({ priceClp: 44990, guardians: true }), 71388);
});

test('catálogo comercial coincide con precios y cupos aprobados', () => {
  assert.deepEqual(
    ['formacion', 'competencia', 'alto_rendimiento'].map((code) => [
      getBillingPlan(code).priceClp,
      getBillingPlan(code).founderPriceClp,
      getBillingPlan(code).professorLimit,
      getBillingPlan(code).playerLimit,
    ]),
    [[44990, 39990, 5, 100], [99990, 79990, 10, 300], [149990, 119990, 30, null]],
  );
});

test('anual cobra diez meses y habilita doce', () => {
  const quote = getBillingQuote({ planCode: 'competencia', billingCycle: 'annual' });
  assert.equal(quote.chargedNetClp, 999900);
  assert.equal(quote.regularNetClp, 1199880);
  assert.equal(quote.billingPeriodMonths, 12);
  assert.equal(quote.monthlyEquivalentNetClp, 83325);
});

test('Apoderados PRO anual cobra diez meses y dura doce', () => {
  const addon = guardianAddonQuote('annual');
  assert.equal(addon.chargedNetClp, 150000);
  assert.equal(addon.regularNetClp, 180000);
  assert.equal(addon.billingPeriodMonths, 12);
  const quote = getBillingQuote({ planCode: 'formacion', billingCycle: 'annual', guardians: true });
  assert.equal(quote.chargedNetClp, 599900);
  assert.equal(quote.guardianChargedNetClp, 150000);
});

test('fundador usa precio especial mensual y add-on conserva precio lista', () => {
  const quote = getBillingQuote({ planCode: 'alto_rendimiento', promotionCode: 'founder', guardians: true });
  assert.equal(quote.baseChargedNetClp, 119990);
  assert.equal(quote.guardianChargedNetClp, 15000);
  assert.equal(quote.chargedNetClp, 134990);
  assert.equal(quote.billingCycle, 'monthly');
  assert.throws(
    () => getBillingQuote({ planCode: 'formacion', billingCycle: 'annual', promotionCode: 'founder' }),
    (error) => error.code === 'PROMOTION_NOT_STACKABLE',
  );
});
