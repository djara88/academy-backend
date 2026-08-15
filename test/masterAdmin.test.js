const test = require('node:test');
const assert = require('node:assert/strict');
const { getMasterAdminEmail, isMasterAdminEmail } = require('../middleware/masterAdmin');

const withSuperadminEmail = (value, fn) => {
  const previous = process.env.SUPERADMIN_EMAIL;
  if (value == null) delete process.env.SUPERADMIN_EMAIL;
  else process.env.SUPERADMIN_EMAIL = value;
  try {
    fn();
  } finally {
    if (previous == null) delete process.env.SUPERADMIN_EMAIL;
    else process.env.SUPERADMIN_EMAIL = previous;
  }
};

test('reconoce el correo maestro configurado sin depender de mayúsculas o espacios', () => {
  withSuperadminEmail(' d.jarazerene@gmail.com ', () => {
    assert.equal(getMasterAdminEmail(), 'd.jarazerene@gmail.com');
    assert.equal(isMasterAdminEmail('  D.JARAZERENE@GMAIL.COM '), true);
    assert.equal(isMasterAdminEmail('director@example.com'), false);
  });
});

test('sin SUPERADMIN_EMAIL configurado no existe fallback maestro', () => {
  withSuperadminEmail(null, () => {
    assert.equal(getMasterAdminEmail(), '');
    assert.equal(isMasterAdminEmail('d.jarazerene@gmail.com'), false);
    assert.equal(isMasterAdminEmail(undefined), false);
  });
});
