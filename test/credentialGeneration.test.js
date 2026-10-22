const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { generateTemporaryPassword } = require('../services/credentialGeneration');

test('contraseñas administrativas usan CSPRNG y complejidad consistente', () => {
  const generated = new Set(Array.from({ length: 128 }, () => generateTemporaryPassword()));
  assert.equal(generated.size, 128, 'no collisions across 128 generated credentials');
  for (const password of generated) {
    assert.ok(password.length >= 32);
    assert.match(password, /[a-z]/);
    assert.match(password, /[A-Z]/);
    assert.match(password, /[0-9]/);
    assert.match(password, /[^a-zA-Z0-9]/);
  }
});

test('alta administrativa usa CSPRNG; recuperación usa enlace sin reemplazar la clave', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'academias.js'), 'utf8');
  assert.doesNotMatch(source, /Math\.random\(/);
  assert.match(source, /const tempPassword = generateTemporaryPassword\(\)/);
  const reset = source.split("router.post('/:id/reset-password'")[1]?.split('// RUTAS DE TÉRMINOS Y CONDICIONES')[0];
  assert.ok(reset, 'administrative recovery route exists');
  assert.match(reset, /type: 'recovery'/);
  assert.doesNotMatch(reset, /generateTemporaryPassword\(/);
  assert.doesNotMatch(reset, /updateUserById/);
});
