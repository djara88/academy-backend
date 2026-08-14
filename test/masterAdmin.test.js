const test = require('node:test');
const assert = require('node:assert/strict');
const { isMasterAdminEmail } = require('../middleware/masterAdmin');

test('reconoce el correo maestro sin depender de mayúsculas o espacios', () => {
  assert.equal(isMasterAdminEmail('  D.JARAZERENE@GMAIL.COM '), true);
});

test('rechaza cualquier otro correo', () => {
  assert.equal(isMasterAdminEmail('director@example.com'), false);
  assert.equal(isMasterAdminEmail(undefined), false);
});
