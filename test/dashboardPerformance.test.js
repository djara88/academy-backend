const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dashboard = fs.readFileSync(path.join(__dirname, '..', 'routes', 'dashboard.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260816210500_dashboard_kpis_compact_rpc.sql'), 'utf8');

test('dashboard usa RPC compacto para KPIs', () => {
  assert.match(dashboard, /supabase\.rpc\('obtener_dashboard_kpis'/);
  assert.doesNotMatch(dashboard, /from\('pagos'\)/);
  assert.doesNotMatch(dashboard, /from\('egresos'\)/);
  assert.doesNotMatch(dashboard, /from\('cobros'\)/);
  assert.doesNotMatch(dashboard, /from\('entrenamientos'\)/);
});

test('mantenimiento mensual del dashboard se deduplica temporalmente', () => {
  assert.match(dashboard, /DASHBOARD_BILLING_CACHE_TTL_MS/);
  assert.match(dashboard, /cached\?\.promise/);
  assert.match(dashboard, /ensureMonthlyChargesForAcademy\(academyId\)/);
});

test('RPC de dashboard queda restringido a service_role', () => {
  assert.match(migration, /security definer/i);
  assert.match(migration, /revoke all on function public\.obtener_dashboard_kpis\(uuid,date,date,date\) from authenticated/i);
  assert.match(migration, /grant execute on function public\.obtener_dashboard_kpis\(uuid,date,date,date\) to service_role/i);
});
