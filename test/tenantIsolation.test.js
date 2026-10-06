const test = require('node:test');
const assert = require('node:assert/strict');
const { requireTenantContext } = require('../middleware/tenantContext');
const { createTenantRepository } = require('../services/tenantRepository');

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

test('tenant context rejects a client-supplied foreign academia_id', () => {
  const res = response();
  let nextCalled = false;
  requireTenantContext({
    user: { id: 'user-a', rol: 'director', academia_id: 'academy-a' },
    body: { academia_id: 'academy-b' },
    query: {},
    params: {},
  }, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'CROSS_TENANT_ACCESS_DENIED');
});

test('tenant context is immutable and derived from the authenticated user', () => {
  const res = response();
  const req = {
    user: { id: 'user-a', rol: 'director', academia_id: 'academy-a' },
    body: {},
    query: {},
    params: {},
  };
  let nextCalled = false;
  requireTenantContext(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.deepEqual(req.tenant, { academyId: 'academy-a', isSuperadmin: false });
  assert.equal(Object.isFrozen(req.tenant), true);
});

const fakeClient = () => {
  const calls = [];
  const builder = {
    select(columns, options) { calls.push(['select', columns, options]); return this; },
    update(values) { calls.push(['update', values]); return this; },
    delete() { calls.push(['delete']); return this; },
    insert(values, options) { calls.push(['insert', values, options]); return this; },
    upsert(values, options) { calls.push(['upsert', values, options]); return this; },
    eq(column, value) { calls.push(['eq', column, value]); return this; },
  };
  return {
    calls,
    client: {
      from(table) {
        calls.push(['from', table]);
        return Object.create(builder);
      },
    },
  };
};

test('tenant repository always scopes reads, updates and deletes by academia_id', () => {
  const { client, calls } = fakeClient();
  const repo = createTenantRepository({ academyId: 'academy-a', client });
  repo.table('jugadores').select('id,nombre');
  repo.table('jugadores').update({ nombre: 'Nuevo' });
  repo.table('jugadores').delete();

  const tenantFilters = calls.filter((call) => call[0] === 'eq' && call[1] === 'academia_id');
  assert.equal(tenantFilters.length, 3);
  assert.ok(tenantFilters.every((call) => call[2] === 'academy-a'));
});

test('tenant repository injects tenant on writes and rejects foreign tenant values', () => {
  const { client, calls } = fakeClient();
  const repo = createTenantRepository({ academyId: 'academy-a', client });
  repo.table('jugadores').insert({ nombre: 'Alumno' });
  const insert = calls.find((call) => call[0] === 'insert');
  assert.equal(insert[1].academia_id, 'academy-a');

  assert.throws(
    () => repo.table('jugadores').insert({ nombre: 'Intruso', academia_id: 'academy-b' }),
    (error) => error?.code === 'CROSS_TENANT_ACCESS_DENIED',
  );
  assert.throws(
    () => repo.table('jugadores').update({ academia_id: 'academy-b' }),
    (error) => error?.code === 'CROSS_TENANT_ACCESS_DENIED',
  );
});
