const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('health check público no expone detalles internos', () => {
  const server = read('server.js');
  const health = server.match(/app\.get\('\/health'[\s\S]*?\);\n\napp\.post\('\/api\/cambiar-password'/)?.[0] || '';
  assert.ok(health, 'Debe existir el health check');
  assert.match(health, /res\.json\(\{ status: 'ok' \}\)/);
  assert.doesNotMatch(health, /RENDER_GIT_COMMIT|memoryUsage|uptime_seconds|memory_rss_mb|features/);
});

test('estado público de Mercado Pago expone solo datos necesarios y no se cachea', () => {
  const source = read('routes/mercadoPago.js');
  const route = source.match(/router\.get\('\/order\/:id'[\s\S]*?router\.post\('\/webhook'/)?.[0] || '';
  assert.ok(route, 'Debe existir la consulta pública de estado de orden');
  assert.match(route, /amount_expected,amount_approved,status,approved_at,created_at/);
  assert.match(route, /Cache-Control', 'no-store'/);
  assert.doesNotMatch(route, /payment_id|\bscope\b|merchant_user_id|payer_email|external_reference/);
});

test('las funciones nuevas de Supabase nacen cerradas para roles cliente', () => {
  const migration = read('supabase/migrations/20260821154500_harden_future_function_privileges.sql');
  assert.match(migration, /schema public[\s\S]*revoke execute on functions from public/i);
  assert.match(migration, /schema public[\s\S]*revoke execute on functions from anon, authenticated/i);
  assert.match(migration, /schema public[\s\S]*grant execute on functions to service_role/i);
  assert.match(migration, /schema private[\s\S]*revoke execute on functions from public/i);
});
