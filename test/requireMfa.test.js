const test = require('node:test');
const assert = require('node:assert/strict');
const { requireSuperadminMfa } = require('../middleware/requireMfa');

const runMiddleware = ({ role = 'superadmin', aal = 'aal1' }) => {
  let nextCalled = false;
  let statusCode = null;
  let body = null;
  const req = { user: { rol: role }, auth: { aal } };
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return this; },
  };
  requireSuperadminMfa(req, res, () => { nextCalled = true; });
  return { nextCalled, statusCode, body };
};

test('superadmin AAL1 siempre queda bloqueado', () => {
  const result = runMiddleware({ aal: 'aal1' });
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.body.code, 'MFA_REQUIRED');
  assert.equal(result.body.required_aal, 'aal2');
});

test('superadmin AAL2 puede continuar', () => {
  const result = runMiddleware({ aal: 'aal2' });
  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, null);
});

test('MFA de superadmin no interfiere con otros roles', () => {
  const result = runMiddleware({ role: 'director', aal: 'aal1' });
  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, null);
});

