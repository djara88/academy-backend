const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const legacy = fs.readFileSync(path.join(__dirname, '..', 'routes', 'finanzas.js'), 'utf8');
const multibranch = fs.readFileSync(path.join(__dirname, '..', 'routes', 'finanzasMultirama.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260908193000_finance_manual_write_idempotency.sql'), 'utf8');

test('cobros y egresos tienen claves idempotentes únicas por academia', () => {
  assert.match(migration, /alter table public\.cobros add column if not exists idempotency_key text/i);
  assert.match(migration, /alter table public\.egresos add column if not exists idempotency_key text/i);
  assert.match(migration, /cobros_academia_idempotency_key_unique/i);
  assert.match(migration, /egresos_academia_idempotency_key_unique/i);
  assert.match(migration, /on public\.cobros \(academia_id, idempotency_key\)/i);
  assert.match(migration, /on public\.egresos \(academia_id, idempotency_key\)/i);
});

test('rutas financieras consolidadas reutilizan la misma operación y rechazan payload distinto', () => {
  assert.match(legacy, /findIdempotentRow\('cobros'/);
  assert.match(legacy, /sameChargeWrite/);
  assert.match(legacy, /findIdempotentRow\('egresos'/);
  assert.match(legacy, /sameExpenseWrite/);
  assert.match(legacy, /IDEMPOTENCY_KEY_REUSED/);
  assert.match(legacy, /insertResult\.error\.code === '23505'/);
});

test('rutas multirrama conservan idempotencia y alcance de rama', () => {
  assert.match(multibranch, /sameBranchCharge/);
  assert.match(multibranch, /sameBranchExpense/);
  assert.match(multibranch, /String\(existing\.rama_id \|\| ''\) === String\(payload\.rama_id \|\| ''\)/);
  assert.match(multibranch, /IDEMPOTENCY_KEY_REUSED/);
  assert.match(multibranch, /insertResult\.error\.code === '23505'/);
});

test('el pago existente mantiene su RPC idempotente', () => {
  assert.match(legacy, /registrar_pago_cobro/);
  assert.match(legacy, /p_idempotency_key: req\.body\.idempotency_key \|\| null/);
});
