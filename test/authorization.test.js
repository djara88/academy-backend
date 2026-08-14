const test = require('node:test');
const assert = require('node:assert/strict');
const { requireSuperadmin, requireOwnAcademyOrSuperadmin } = require('../middleware/authorization');

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  }
});

test('requireSuperadmin acepta variantes de mayúsculas', () => {
  const res = response();
  let nextCalled = false;
  requireSuperadmin({ user: { rol: 'SUPERADMIN' } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});

test('requireSuperadmin acepta la variante SUPER_ADMIN usada por el frontend', () => {
  const res = response();
  let nextCalled = false;
  requireSuperadmin({ user: { rol: 'SUPER_ADMIN' } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});

test('requireSuperadmin bloquea directores', () => {
  const res = response();
  requireSuperadmin({ user: { rol: 'director' } }, res, () => assert.fail('No debe continuar'));
  assert.equal(res.statusCode, 403);
});

test('requireOwnAcademyOrSuperadmin limita por academia', () => {
  const allowed = response();
  let nextCalled = false;
  requireOwnAcademyOrSuperadmin({ user: { rol: 'director', academia_id: 'academy-a' }, params: { id: 'academy-a' } }, allowed, () => { nextCalled = true; });
  assert.equal(nextCalled, true);

  const denied = response();
  requireOwnAcademyOrSuperadmin({ user: { rol: 'director', academia_id: 'academy-a' }, params: { id: 'academy-b' } }, denied, () => assert.fail('No debe continuar'));
  assert.equal(denied.statusCode, 403);
});
