const fs = require('node:fs');

const enrollment = fs.readFileSync('services/sportEnrollmentService.js', 'utf8');
const inscripciones = fs.readFileSync('routes/inscripciones.js', 'utf8');
const prematriculas = fs.readFileSync('routes/prematriculas.js', 'utf8');
const mercadoPago = fs.readFileSync('routes/mercadoPago.js', 'utf8');
const platform = fs.readFileSync('routes/platformCheckout.js', 'utf8');
const collectionPortal = fs.readFileSync('routes/collectionsPortal.js', 'utf8');
const paymentReceipts = fs.readFileSync('routes/paymentReceipts.js', 'utf8');
const uniformLegacy = fs.readFileSync('routes/uniformes.js', 'utf8');
const uniformMulti = fs.readFileSync('routes/uniformesMultirama.js', 'utf8');
const uniformService = fs.readFileSync('services/uniformOrderService.js', 'utf8');
const idempotency = fs.readFileSync('services/idempotency.js', 'utf8');
const uniformMigration = fs.readFileSync('supabase/migrations/20261007161115_phase3_uniform_order_idempotency.sql', 'utf8');

if (!enrollment.includes("supabase.rpc('create_sport_enrollment_v2'")) {
  throw new Error('Phase 3 idempotency audit failed: sport enrollment must use create_sport_enrollment_v2.');
}
if (/from\('inscripciones_deportivas'\)\.insert/.test(enrollment)) {
  throw new Error('Phase 3 idempotency audit failed: sequential enrollment insert returned.');
}

for (const [name, source, expected] of [
  ['prematriculas', prematriculas, 'idempotency_key: idempotencyKey'],
  ['mercadoPago', mercadoPago, 'idempotency_key: idempotencyKey'],
  ['platformCheckout', platform, 'createOrReuseCharge'],
  ['inscripciones', inscripciones, 'solicitudId: request.id'],
  ['collectionPortal', collectionPortal, 'resolveIdempotencyKey'],
  ['paymentReceipts', paymentReceipts, 'resolveIdempotencyKey'],
  ['uniformLegacy', uniformLegacy, 'createUniformOrder'],
  ['uniformMulti', uniformMulti, 'createUniformOrder'],
  ['uniformService', uniformService, "supabase.rpc('create_uniform_order_v1'"],
]) {
  if (!source.includes(expected)) throw new Error(`Phase 3 idempotency audit failed: ${name} missing ${expected}.`);
}

for (const [name, source] of [
  ['collectionPortal', collectionPortal],
  ['paymentReceipts', paymentReceipts],
]) {
  if (/idempotency[^\n]{0,180}randomUUID\s*\(/i.test(source)) {
    throw new Error(`Phase 3 idempotency audit failed: ${name} restored a random idempotency fallback.`);
  }
}

for (const [name, source] of [
  ['uniformLegacy', uniformLegacy],
  ['uniformMulti', uniformMulti],
]) {
  const route = source.match(/router\.post\('\/pedidos'[\s\S]*?(?=\nrouter\.)/)?.[0] || '';
  for (const forbidden of ["from('cobros').insert", "from('pedidos_indumentaria').insert", 'stock_disponible - 1']) {
    if (route.includes(forbidden)) {
      throw new Error(`Phase 3 idempotency audit failed: ${name} restored sequential uniform write ${forbidden}.`);
    }
  }
}

for (const required of [
  'pg_advisory_xact_lock',
  'insert into public.cobros',
  'insert into public.pedidos_indumentaria',
  'stock_disponible = stock_disponible - 1',
  'idempotency_key',
  'revoke execute on function public.create_uniform_order_v1',
  'from public, anon, authenticated',
  'to service_role',
]) {
  if (!uniformMigration.toLowerCase().includes(required.toLowerCase())) {
    throw new Error(`Phase 3 idempotency audit failed: uniform migration missing ${required}.`);
  }
}

for (const expected of ['fingerprint', 'windowBucket', 'resolveIdempotencyKey']) {
  if (!idempotency.includes(expected)) throw new Error(`Phase 3 idempotency audit failed: helper missing ${expected}.`);
}

console.log('Phase 3 idempotency audit passed.');
