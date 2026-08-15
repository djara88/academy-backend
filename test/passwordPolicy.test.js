const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePassword } = require('../services/passwordPolicy');

test('rechaza contraseñas demasiado cortas', () => {
  assert.equal(validatePassword('Aa1!short').valid, false);
});

test('rechaza contraseñas sin complejidad requerida', () => {
  assert.equal(validatePassword('solominusculas123').valid, false);
  assert.equal(validatePassword('SOLOMAYUSCULAS123!').valid, false);
  assert.equal(validatePassword('SinNumeros!!').valid, false);
  assert.equal(validatePassword('SinSimbolo123A').valid, false);
});

test('acepta una contraseña fuerte', () => {
  assert.equal(validatePassword('Syncademia9!').valid, true);
});
