const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateGrossClp, getBillingPlan } = require('../services/billingCatalog');

test('calcula plan y add-on con IVA chileno', () => {
  assert.equal(calculateGrossClp({ priceUf: 1.5, guardians: true, ufValue: 40000 }), 88060);
});

test('catálogo comercial coincide con los cupos del producto', () => {
  assert.deepEqual(
    ['formacion', 'competencia', 'alto_rendimiento'].map((code) => [getBillingPlan(code).priceUf, getBillingPlan(code).professorLimit]),
    [[0.75, 3], [1.5, 10], [2.5, 30]],
  );
});
