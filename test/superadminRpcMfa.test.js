const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261016115000_require_superadmin_mfa_in_rpc.sql'), 'utf8');

test('el RPC maestro no autoriza con UUID solamente: requiere aal2 en JWT de Supabase', () => {
  assert.match(migration, /create or replace function public\.get_saas_academies_admin\(\)/i);
  assert.match(migration, /security definer/i);
  assert.match(migration, /set search_path = ''/i);
  assert.match(migration, /v_uid is distinct from '41927ee7-9dfc-4810-8a6d-7751346a155b'::uuid/);
  assert.match(migration, /coalesce\(auth\.jwt\(\)->>'aal', 'aal1'\) <> 'aal2'/);
  assert.match(migration, /raise exception 'forbidden' using errcode = '42501'/);
  assert.match(migration, /revoke all on function public\.get_saas_academies_admin\(\) from public/i);
  assert.match(migration, /grant execute on function public\.get_saas_academies_admin\(\) to authenticated/i);
});
