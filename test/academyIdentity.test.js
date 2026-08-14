const test = require('node:test');
const assert = require('node:assert/strict');
const { academyMessage, normalizeAcademyName } = require('../services/academyIdentity');

test('firma cada mensaje con el nombre de la academia', () => {
  const message = academyMessage('Club Los Leones', 'Entrenamiento confirmado.');
  assert.match(message, /^🏟️ \*Club Los Leones\*/);
  assert.match(message, /— Equipo de \*Club Los Leones\*$/);
});

test('usa un nombre neutro si falta la identidad', () => {
  assert.equal(normalizeAcademyName('  '), 'Tu academia');
});
