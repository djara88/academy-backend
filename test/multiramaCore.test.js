const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveDiscipline, defaultBranchName, ALLOWED_DISCIPLINES } = require('../services/academyStructureService');
const { assertSameBranch } = require('../services/branchContext');

test('onboarding reconoce disciplinas principales canónicas y alias', () => {
  assert.equal(resolveDiscipline('Fútbol'), 'Fútbol');
  assert.equal(resolveDiscipline('futbol'), 'Fútbol');
  assert.equal(resolveDiscipline('Karate-do'), 'Karate');
  assert.equal(resolveDiscipline('BASQUET'), 'Básquetbol');
  assert.equal(resolveDiscipline('deporte inventado'), null);
  assert.ok(ALLOWED_DISCIPLINES.includes('Karate'));
});

test('la rama inicial usa la disciplina como nombre salvo Otro', () => {
  assert.equal(defaultBranchName('Tenis'), 'Tenis');
  assert.equal(defaultBranchName('Otro'), 'Disciplina principal');
});

test('operaciones cruzadas entre ramas se bloquean', () => {
  assert.doesNotThrow(() => assertSameBranch('rama-a', 'rama-a'));
  assert.throws(
    () => assertSameBranch('rama-a', 'rama-b'),
    (error) => error?.code === 'BRANCH_SCOPE_MISMATCH' && error?.status === 409,
  );
});
