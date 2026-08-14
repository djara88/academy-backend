const test = require('node:test');
const assert = require('node:assert/strict');
const { requireAcademyParamAccess } = require('../middleware/academyAccess');

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

test('permite operar solamente la academia del usuario', () => {
  const middleware = requireAcademyParamAccess('academiaId');
  let allowed = false;
  middleware({ user: { academia_id: 'academy-a', rol: 'director' }, params: { academiaId: 'academy-a' } }, response(), () => { allowed = true; });
  assert.equal(allowed, true);

  const denied = response();
  middleware({ user: { academia_id: 'academy-a', rol: 'director' }, params: { academiaId: 'academy-b' } }, denied, () => assert.fail('No debe continuar'));
  assert.equal(denied.statusCode, 403);
});

test('permite al superadministrador operar cualquier academia', () => {
  const middleware = requireAcademyParamAccess('academiaId');
  let allowed = false;
  middleware({ user: { rol: 'SUPER_ADMIN' }, params: { academiaId: 'academy-b' } }, response(), () => { allowed = true; });
  assert.equal(allowed, true);
});
