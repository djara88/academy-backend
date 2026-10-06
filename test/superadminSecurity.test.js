const test = require('node:test');
const assert = require('node:assert/strict');

const { isMasterAdminUser } = require('../middleware/masterAdmin');
const { requireSuperadminMfa } = require('../middleware/requireMfa');
const { requireSuperadmin } = require('../middleware/authorization');

const AUTHORIZED_ID = '41927ee7-9dfc-4810-8a6d-7751346a155b';
const OTHER_ID = '11111111-1111-4111-8111-111111111111';

const withSuperadminEnv = (fn) => {
  const previousId = process.env.SUPERADMIN_USER_ID;
  const previousEmail = process.env.SUPERADMIN_EMAIL;
  const previousMfa = process.env.SUPERADMIN_MFA_ENFORCE;
  try {
    return fn();
  } finally {
    if (previousId === undefined) delete process.env.SUPERADMIN_USER_ID;
    else process.env.SUPERADMIN_USER_ID = previousId;
    if (previousEmail === undefined) delete process.env.SUPERADMIN_EMAIL;
    else process.env.SUPERADMIN_EMAIL = previousEmail;
    if (previousMfa === undefined) delete process.env.SUPERADMIN_MFA_ENFORCE;
    else process.env.SUPERADMIN_MFA_ENFORCE = previousMfa;
  }
};

const mockResponse = () => {
  const state = { statusCode: 200, body: null };
  return {
    state,
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(body) {
      state.body = body;
      return this;
    },
  };
};

test('master admin identity ignores email fallback and requires configured UUID', () => withSuperadminEnv(() => {
  delete process.env.SUPERADMIN_USER_ID;
  process.env.SUPERADMIN_EMAIL = 'admin@example.com';
  assert.equal(isMasterAdminUser({ id: OTHER_ID, email: 'admin@example.com' }), false);

  process.env.SUPERADMIN_USER_ID = AUTHORIZED_ID;
  assert.equal(isMasterAdminUser({ id: AUTHORIZED_ID, email: 'other@example.com' }), true);
  assert.equal(isMasterAdminUser({ id: OTHER_ID, email: 'admin@example.com' }), false);
}));

test('superadmin MFA fails closed at AAL1 even when legacy bypass variable is disabled', () => withSuperadminEnv(() => {
  process.env.SUPERADMIN_MFA_ENFORCE = 'false';
  const res = mockResponse();
  let nextCalled = false;

  requireSuperadminMfa(
    { user: { rol: 'superadmin' }, auth: { aal: 'aal1' } },
    res,
    () => { nextCalled = true; },
  );

  assert.equal(nextCalled, false);
  assert.equal(res.state.statusCode, 403);
  assert.equal(res.state.body?.code, 'MFA_REQUIRED');
  assert.equal(res.state.body?.required_aal, 'aal2');
}));

test('superadmin MFA permits only an AAL2 master session', () => {
  const res = mockResponse();
  let nextCalled = false;

  requireSuperadminMfa(
    { user: { rol: 'superadmin' }, auth: { aal: 'aal2' } },
    res,
    () => { nextCalled = true; },
  );

  assert.equal(nextCalled, true);
  assert.equal(res.state.statusCode, 200);
});

test('superadmin authorization requires both role and configured UUID', () => withSuperadminEnv(() => {
  process.env.SUPERADMIN_USER_ID = AUTHORIZED_ID;

  const denied = mockResponse();
  let deniedNext = false;
  requireSuperadmin(
    { user: { id: OTHER_ID, rol: 'superadmin' } },
    denied,
    () => { deniedNext = true; },
  );
  assert.equal(deniedNext, false);
  assert.equal(denied.state.statusCode, 403);
  assert.equal(denied.state.body?.code, 'SUPERADMIN_IDENTITY_REQUIRED');

  const allowed = mockResponse();
  let allowedNext = false;
  requireSuperadmin(
    { user: { id: AUTHORIZED_ID, rol: 'superadmin' } },
    allowed,
    () => { allowedNext = true; },
  );
  assert.equal(allowedNext, true);
  assert.equal(allowed.state.statusCode, 200);
}));
