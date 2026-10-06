const test = require('node:test');
const assert = require('node:assert/strict');
const { requireAcademyParamAccess } = require('../middleware/academyAccess');

const AUTHORIZED_ID = '41927ee7-9dfc-4810-8a6d-7751346a155b';

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

const withMasterId = (fn) => {
  const previous = process.env.SUPERADMIN_USER_ID;
  process.env.SUPERADMIN_USER_ID = AUTHORIZED_ID;
  try { return fn(); }
  finally {
    if (previous == null) delete process.env.SUPERADMIN_USER_ID;
    else process.env.SUPERADMIN_USER_ID = previous;
  }
};

test('permite operar solamente la academia del usuario', () => {
  const middleware = requireAcademyParamAccess('academiaId');
  let allowed = false;
  middleware({ user: { academia_id: 'academy-a', rol: 'director' }, params: { academiaId: 'academy-a' } }, response(), () => { allowed = true; });
  assert.equal(allowed, true);

  const denied = response();
  middleware({ user: { academia_id: 'academy-a', rol: 'director' }, params: { academiaId: 'academy-b' } }, denied, () => assert.fail('No debe continuar'));
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.code, 'CROSS_TENANT_ACCESS_DENIED');
});

test('solo el UUID maestro autorizado puede operar cualquier academia', () => withMasterId(() => {
  const middleware = requireAcademyParamAccess('academiaId');

  const fake = response();
  middleware({ user: { id: '11111111-1111-4111-8111-111111111111', rol: 'SUPER_ADMIN' }, params: { academiaId: 'academy-b' } }, fake, () => assert.fail('No debe continuar'));
  assert.equal(fake.statusCode, 403);

  let allowed = false;
  middleware({ user: { id: AUTHORIZED_ID, rol: 'SUPER_ADMIN' }, params: { academiaId: 'academy-b' } }, response(), () => { allowed = true; });
  assert.equal(allowed, true);
}));
