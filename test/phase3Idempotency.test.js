const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('inscripciones deportivas usan RPC atómica e idempotente', () => {
  const service = read('services/sportEnrollmentService.js');
  assert.match(service, /supabase\.rpc\('create_sport_enrollment_v2'/);
  assert.match(service, /p_idempotency_key/);
  assert.match(service, /deterministicEnrollmentKey/);
  assert.doesNotMatch(service, /from\('inscripciones_deportivas'\)\.insert/);
  assert.doesNotMatch(service, /createdChargeIds/);
});

test('aprobación de solicitud ocurre dentro de la RPC', () => {
  const route = read('routes/inscripciones.js');
  const block = route.match(/router\.post\('\/solicitudes\/:id\/aprobar'[\s\S]*?router\.post\('\/solicitudes\/:id\/rechazar'/)?.[0] || '';
  assert.ok(block);
  assert.match(block, /solicitudId:\s*request\.id/);
  assert.match(block, /sport-request:/);
  assert.doesNotMatch(block, /solicitudes_inscripcion_deportiva'\)\.update/);
});

test('pre-matrícula activa usa idempotencia persistente', () => {
  const route = read('routes/prematriculas.js');
  const block = route.match(/router\.post\('\/'[\s\S]*?router\.put\('\/:id'/)?.[0] || '';
  assert.match(block, /idempotency_key:\s*idempotencyKey/);
  assert.match(block, /idempotency_fingerprint:\s*fingerprint/);
  assert.match(block, /error\.code === '23505'/);
  assert.match(block, /No se creó un duplicado/);
});

test('checkout de academia usa clave idempotente a nivel DB', () => {
  const route = read('routes/mercadoPago.js');
  const block = route.match(/const createOrder[\s\S]*?const loadAcademyCheckoutItems/)?.[0] || '';
  assert.match(block, /idempotency_key:\s*idempotencyKey/);
  assert.match(block, /CHECKOUT_IN_PROGRESS/);
  assert.match(block, /error\.code === '23505'/);
});

test('checkout de plataforma reutiliza cobros y órdenes activas', () => {
  const route = read('routes/platformCheckout.js');
  assert.match(route, /createOrReuseCharge/);
  assert.match(route, /plataforma_cobros.*idempotency_key/s);
  assert.match(route, /platform-checkout:/);
  assert.match(route, /CHECKOUT_IN_PROGRESS/);
});

test('migraciones versionan índices idempotentes activos', () => {
  const migration = read('supabase/migrations/20261007152000_phase3_checkout_and_prematricula_active_idempotency.sql');
  assert.match(migration, /payment_gateway_orders_active_idempotency_uq/);
  assert.match(migration, /status in \('created','pending'\)/);
  assert.match(migration, /prematriculas_academia_idempotency_uq/);
  assert.match(migration, /estado in \('enviada','abierta','procesando'\)/);
});
