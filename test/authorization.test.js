const test = require('node:test');
const assert = require('node:assert/strict');
const { requireSuperadmin, requireOwnAcademyOrSuperadmin } = require('../middleware/authorization');

const AUTHORIZED_ID = '41927ee7-9dfc-4810-8a6d-7751346a155b';

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

const withMasterId = (fn) => {
  const previous = process.env.SUPERADMIN_USER_ID;
  process.env.SUPERADMIN_USER_ID = AUTHORIZED_ID;
  try {
    return fn();
  } finally {
    if (previous == null) delete process.env.SUPERADMIN_USER_ID;
    else process.env.SUPERADMIN_USER_ID = previous;
  }
};

test('requireSuperadmin acepta variantes de mayúsculas solo para el UUID maestro', () => withMasterId(() => {
  const res = response();
  let nextCalled = false;
  requireSuperadmin({ user: { id: AUTHORIZED_ID, rol: 'SUPERADMIN' }, auth: { aal: 'aal2' } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
}));

test('requireSuperadmin acepta SUPER_ADMIN solo para el UUID maestro', () => withMasterId(() => {
  const res = response();
  let nextCalled = false;
  requireSuperadmin({ user: { id: AUTHORIZED_ID, rol: 'SUPER_ADMIN' }, auth: { aal: 'aal2' } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
}));

test('requireSuperadmin bloquea roles o UUID no autorizados', () => withMasterId(() => {
  const director = response();
  requireSuperadmin({ user: { id: AUTHORIZED_ID, rol: 'director' } }, director, () => assert.fail('No debe continuar'));
  assert.equal(director.statusCode, 403);

  const fakeAdmin = response();
  requireSuperadmin({ user: { id: '11111111-1111-4111-8111-111111111111', rol: 'superadmin' } }, fakeAdmin, () => assert.fail('No debe continuar'));
  assert.equal(fakeAdmin.statusCode, 403);
  assert.equal(fakeAdmin.body.code, 'SUPERADMIN_IDENTITY_REQUIRED');
}));

test('requireOwnAcademyOrSuperadmin limita por academia y reserva bypass al UUID maestro', () => withMasterId(() => {
  const allowed = response();
  let nextCalled = false;
  requireOwnAcademyOrSuperadmin({ user: { rol: 'director', academia_id: 'academy-a' }, params: { id: 'academy-a' } }, allowed, () => { nextCalled = true; });
  assert.equal(nextCalled, true);

  const denied = response();
  requireOwnAcademyOrSuperadmin({ user: { rol: 'director', academia_id: 'academy-a' }, params: { id: 'academy-b' } }, denied, () => assert.fail('No debe continuar'));
  assert.equal(denied.statusCode, 403);

  const fakeAdmin = response();
  requireOwnAcademyOrSuperadmin({ user: { id: '11111111-1111-4111-8111-111111111111', rol: 'superadmin', academia_id: null }, params: { id: 'academy-b' } }, fakeAdmin, () => assert.fail('No debe continuar'));
  assert.equal(fakeAdmin.statusCode, 403);
}));


test('un JWT del superadministrador sin MFA AAL2 nunca permite operar ni consultar academias ajenas', () => withMasterId(() => {
  for (const aal of ['aal1', undefined]) {
    const admin = { user: { id: AUTHORIZED_ID, rol: 'superadmin', academia_id: null }, auth: aal ? { aal } : undefined };
    const resAdmin = response();
    requireSuperadmin(admin, resAdmin, () => assert.fail('Master route must require AAL2'));
    assert.equal(resAdmin.statusCode, 403);
    assert.equal(resAdmin.body.code, 'MFA_REQUIRED');
    assert.equal(resAdmin.body.required_aal, 'aal2');

    const resCrossTenant = response();
    requireOwnAcademyOrSuperadmin({ ...admin, params: { id: 'academy-b' } }, resCrossTenant, () => assert.fail('Cross-academy route must require AAL2'));
    assert.equal(resCrossTenant.statusCode, 403);
    assert.equal(resCrossTenant.body.code, 'MFA_REQUIRED');
  }
}));

test('superadministrador AAL2 puede consultar academia ajena y director conserva acceso a la propia sin MFA', () => withMasterId(() => {
  const resMaster = response();
  let masterAllowed = false;
  requireOwnAcademyOrSuperadmin({
    user: { id: AUTHORIZED_ID, rol: 'superadmin', academia_id: null },
    auth: { aal: 'aal2' },
    params: { id: 'academy-b' },
  }, resMaster, () => { masterAllowed = true; });
  assert.equal(masterAllowed, true);

  const resDirector = response();
  let directorAllowed = false;
  requireOwnAcademyOrSuperadmin({
    user: { id: 'user-a', rol: 'director', academia_id: 'academy-a' },
    auth: { aal: 'aal1' },
    params: { id: 'academy-a' },
  }, resDirector, () => { directorAllowed = true; });
  assert.equal(directorAllowed, true);
}));
