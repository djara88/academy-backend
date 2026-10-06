const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getMasterAdminUserId,
  isMasterAdminConfigured,
  isMasterAdminUser,
} = require('../middleware/masterAdmin');

const AUTHORIZED_ID = '41927ee7-9dfc-4810-8a6d-7751346a155b';
const OTHER_ID = '11111111-1111-4111-8111-111111111111';

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

test('sin SUPERADMIN_USER_ID válido no existe identidad maestra', async () => {
  await withEnv({ SUPERADMIN_USER_ID: null, SUPERADMIN_EMAIL: 'legacy@example.com' }, async () => {
    assert.equal(getMasterAdminUserId(), '');
    assert.equal(isMasterAdminConfigured(), false);
    assert.equal(isMasterAdminUser({ id: AUTHORIZED_ID, email: 'legacy@example.com' }), false);
  });
});

test('SUPERADMIN_USER_ID debe tener formato UUID válido', async () => {
  await withEnv({ SUPERADMIN_USER_ID: 'uuid-maestro' }, async () => {
    assert.equal(isMasterAdminConfigured(), false);
    assert.equal(isMasterAdminUser({ id: 'uuid-maestro' }), false);
  });
});

test('solo el UUID configurado es reconocido como master admin', async () => {
  await withEnv({ SUPERADMIN_USER_ID: AUTHORIZED_ID, SUPERADMIN_EMAIL: 'legacy@example.com' }, async () => {
    assert.equal(isMasterAdminConfigured(), true);
    assert.equal(isMasterAdminUser({ id: AUTHORIZED_ID, email: 'otro@lestra.app' }), true);
    assert.equal(isMasterAdminUser({ id: OTHER_ID, email: 'legacy@example.com' }), false);
  });
});

