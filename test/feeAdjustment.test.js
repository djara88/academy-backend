const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateFeeChange } = require('../services/feeAdjustmentValidation');

const valid = {
  jugador_id: 'c5f954c2-0741-4e42-b822-bbde163a3ceb',
  inscripcion_id: 'a85ca0c4-da84-4a46-8578-f33f96c88bb5',
  tipo: 'mensualidad',
  monto_nuevo: 28000,
  monto_anterior: 35000,
  motivo: 'Beca parcial aprobada por dirección',
  aplicar_cobro_actual: false,
};

test('permite descuentos parciales y becas completas en tarifas futuras', () => {
  assert.equal(validateFeeChange(valid).nuevo, 28000);
  assert.equal(validateFeeChange({ ...valid, monto_nuevo: 0 }).nuevo, 0);
  assert.equal(validateFeeChange({ ...valid, tipo: 'matricula', aplicar_cobro_actual: true }).tipo, 'matricula');
});

test('rechaza cambios sin motivo, importes negativos o fraccionarios y tarifas idénticas', () => {
  const invalid = [
    { motivo: 'ok' },
    { monto_nuevo: -1 },
    { monto_nuevo: 100.5 },
    { monto_nuevo: 35000 },
    { monto_nuevo: '' },
    { monto_nuevo: null },
    { monto_nuevo: 10_000_001 },
    { tipo: 'otro' },
    { aplicar_cobro_actual: 'true' },
    { jugador_id: 'otro-jugador' },
  ];
  for (const change of invalid) {
    assert.throws(() => validateFeeChange({ ...valid, ...change }), Error);
  }
});

test('las rutas financieras exigen director y obtienen la academia del contexto autorizado', () => {
  const routes = fs.readFileSync(path.join(__dirname, '../routes/finanzasTarifas.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(routes, /router\.use\(authMiddleware, requireTenantContext, requireDirector\)/);
  assert.match(routes, /req\.tenant\.academyId/);
  assert.match(routes, /supabase\.rpc\('ajustar_tarifa_deportiva'/);
  assert.match(server, /app\.use\('\/api\/finanzas\/tarifas', finanzasTarifasRoutes\)/);
});

test('migración atómica conserva pagos e historial y limita ejecución a service_role', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261110182000_student_fee_adjustments.sql'), 'utf8');
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /INSERT INTO public\.ajustes_tarifas_deportivas/);
  assert.match(sql, /monto_pagado/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.ajustar_tarifa_deportiva/);
  assert.match(sql, /TO service_role/);
  assert.match(sql, /REVOKE ALL ON FUNCTION/);
  assert.doesNotMatch(sql, /UPDATE public\.pagos/);
  assert.doesNotMatch(sql, /DELETE FROM public\.pagos/);
});
