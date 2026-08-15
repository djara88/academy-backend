const test = require('node:test');
const assert = require('node:assert/strict');
const { requireSuperadminMfa } = require('../middleware/requireMfa');

const runMiddleware = ({ enforce, role = 'superadmin', aal = 'aal1' }) => {
  const previous = process.env.SUPERADMIN_MFA_ENFORCE;
  process.env.SUPERADMIN_MFA_ENFORCE = enforce;
  let nextCalled = false;
  let statusCode = null;
  let body = null;
  const req = { user: { rol: role }, auth: { aal } };
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return this; },
  };
  try {
    requireSuperadminMfa(req, res, () => { nextCalled = true; });
  } finally {
    if (previous == null) delete process.env.SUPERADMIN_MFA_ENFORCE;
    else process.env.SUPERADMIN_MFA_ENFORCE = previous;
  }
  return { nextCalled, statusCode, body };
};

test('con enforcement desactivado no bloquea el panel maestro', () => {
  const result = runMiddleware({ enforce: 'false', aal: 'aal1' });
  assert.equal(result.nextCalled, true);
});

test('con enforcement activo rechaza superadmin AAL1', () => {
  const result = runMiddleware({ enforce: 'true', aal: 'aal1' });
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.body.code, 'MFA_REQUIRED');
});

test('con enforcement activo acepta superadmin AAL2', () => {
  const result = runMiddleware({ enforce: 'true', aal: 'aal2' });
  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, null);
});
