const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getMasterAdminEmail,
  getMasterAdminUserId,
  isMasterAdminEmail,
  isMasterAdminUser,
} = require('../middleware/masterAdmin');

const withEnv = async (values, fn) => {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test('reconoce el correo maestro configurado sin depender de mayúsculas o espacios', async () => {
  await withEnv({ SUPERADMIN_EMAIL: ' d.jarazerene@gmail.com ', SUPERADMIN_USER_ID: null }, async () => {
    assert.equal(getMasterAdminEmail(), 'd.jarazerene@gmail.com');
    assert.equal(getMasterAdminUserId(), '');
    assert.equal(isMasterAdminEmail('  D.JARAZERENE@GMAIL.COM '), true);
    assert.equal(isMasterAdminEmail('director@example.com'), false);
    assert.equal(isMasterAdminUser({ id: 'otro-id', email: 'D.JARAZERENE@GMAIL.COM' }), true);
  });
});

test('sin SUPERADMIN_EMAIL configurado no existe fallback maestro', async () => {
  await withEnv({ SUPERADMIN_EMAIL: null, SUPERADMIN_USER_ID: null }, async () => {
    assert.equal(getMasterAdminEmail(), '');
    assert.equal(getMasterAdminUserId(), '');
    assert.equal(isMasterAdminEmail('d.jarazerene@gmail.com'), false);
    assert.equal(isMasterAdminEmail(undefined), false);
    assert.equal(isMasterAdminUser({ id: 'cualquiera', email: 'd.jarazerene@gmail.com' }), false);
  });
});

test('cuando SUPERADMIN_USER_ID está configurado el UUID prevalece sobre el correo', async () => {
  await withEnv({ SUPERADMIN_EMAIL: 'd.jarazerene@gmail.com', SUPERADMIN_USER_ID: 'uuid-maestro' }, async () => {
    assert.equal(isMasterAdminUser({ id: 'uuid-maestro', email: 'otro@lestra.app' }), true);
    assert.equal(isMasterAdminUser({ id: 'uuid-ajeno', email: 'd.jarazerene@gmail.com' }), false);
  });
});
