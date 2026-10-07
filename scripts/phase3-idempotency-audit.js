const fs = require('node:fs');

const enrollment = fs.readFileSync('services/sportEnrollmentService.js', 'utf8');
const inscripciones = fs.readFileSync('routes/inscripciones.js', 'utf8');
const prematriculas = fs.readFileSync('routes/prematriculas.js', 'utf8');
const mercadoPago = fs.readFileSync('routes/mercadoPago.js', 'utf8');
const platform = fs.readFileSync('routes/platformCheckout.js', 'utf8');

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
]) {
  if (!source.includes(expected)) throw new Error(`Phase 3 idempotency audit failed: ${name} missing ${expected}.`);
}

console.log('Phase 3 idempotency audit passed.');
