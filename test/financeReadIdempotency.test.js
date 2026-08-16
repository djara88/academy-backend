const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const finance = fs.readFileSync(path.join(__dirname, '..', 'routes', 'finanzas.js'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260816212000_finance_matricula_idempotency.sql'), 'utf8');

const currentAccountsBlock = finance.split("router.get('/cuentas-corrientes'")[1]?.split("router.put('/cobros/:id/pagar'")[0] || '';

test('cuentas corrientes es lectura pura y no inserta cobros', () => {
  assert.ok(currentAccountsBlock.length > 100);
  assert.doesNotMatch(currentAccountsBlock, /\.from\('cobros'\)\.insert/);
  assert.doesNotMatch(currentAccountsBlock, /registrar_pago_cobro/);
  assert.doesNotMatch(currentAccountsBlock, /recalculateFinancialStatus/);
});

test('cuentas corrientes agrupa cobros por jugador sin filtro N por M', () => {
  assert.match(currentAccountsBlock, /const cobrosPorJugador = new Map\(\)/);
  assert.match(currentAccountsBlock, /cobrosPorJugador\.get\(jugador\.id\)/);
  assert.doesNotMatch(currentAccountsBlock, /cobros\.filter\(c => c\.jugador_id === jugador\.id\)/);
});

test('lecturas financieras deduplican sincronización mensual concurrente', () => {
  assert.match(finance, /FINANCE_BILLING_CACHE_TTL_MS/);
  assert.match(finance, /cached\?\.promise/);
  assert.match(finance, /getBillingSnapshot\(academia_id\)/);
});

test('la base impide dos matrículas activas para el mismo jugador', () => {
  assert.match(migration, /create unique index if not exists cobros_matricula_jugador_unique/i);
  assert.match(migration, /tipo_concepto = 'Matrícula'/i);
  assert.match(migration, /estado <> 'Anulado'/i);
});
