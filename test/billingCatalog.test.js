const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateGrossClp, getBillingPlan } = require('../services/billingCatalog');

test('calcula IVA chileno sin recargo por apoderados', () => {
  assert.equal(calculateGrossClp({ priceClp: 59000 }), 70210);
  assert.equal(calculateGrossClp({ priceClp: 59000, guardians: true }), 70210);
});

test('catálogo comercial coincide con precios y cupos aprobados', () => {
  assert.deepEqual(
    ['formacion', 'competencia', 'alto_rendimiento'].map((code) => [
      getBillingPlan(code).priceClp,
      getBillingPlan(code).professorLimit,
      getBillingPlan(code).playerLimit,
    ]),
    [[59000, 3, 100], [99000, 10, 300], [149000, 30, null]],
  );
});
