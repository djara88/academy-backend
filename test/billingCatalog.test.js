const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateGrossClp, getBillingPlan } = require('../services/billingCatalog');

test('calcula plan y add-on con IVA chileno', () => {
  assert.equal(calculateGrossClp({ priceClp: 60000, guardians: true }), 89250);
});

test('catálogo comercial coincide con los cupos del producto', () => {
  assert.deepEqual(
    ['formacion', 'competencia', 'alto_rendimiento'].map((code) => [getBillingPlan(code).priceClp, getBillingPlan(code).professorLimit]),
    [[30000, 3], [60000, 10], [100000, 30]],
  );
});
