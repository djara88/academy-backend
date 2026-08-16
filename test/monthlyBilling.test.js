process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-key';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dueDateForPeriod, summarizeCharges } = require('../services/monthlyBilling');

test('día 31 se ajusta al último día real del mes', () => {
  assert.equal(dueDateForPeriod('2027-02-01', 31), '2027-02-28');
  assert.equal(dueDateForPeriod('2028-02-01', 31), '2028-02-29');
  assert.equal(dueDateForPeriod('2026-04-01', 31), '2026-04-30');
});

test('saldo futuro no convierte al alumno en moroso', () => {
  const result = summarizeCharges([{ monto: 30000, monto_pagado: 0, estado: 'Pendiente', fecha_vencimiento: '2026-09-05' }], { today: '2026-09-01', warningDays: 3 });
  assert.equal(result.saldoVencido, 0);
  assert.equal(result.saldoPorVencer, 30000);
  assert.equal(result.estadoCuenta, 'Por vencer');
  assert.equal(result.mostrarAlertaProximoPago, false);
});

test('aviso aparece dentro de la ventana y mora solo después del vencimiento', () => {
  const upcoming = summarizeCharges([{ monto: 30000, monto_pagado: 0, estado: 'Pendiente', fecha_vencimiento: '2026-09-05' }], { today: '2026-09-02', warningDays: 3 });
  assert.equal(upcoming.mostrarAlertaProximoPago, true);
  assert.equal(upcoming.estadoCuenta, 'Por vencer');
  const overdue = summarizeCharges([{ monto: 30000, monto_pagado: 0, estado: 'Pendiente', fecha_vencimiento: '2026-09-05' }], { today: '2026-09-06', warningDays: 3 });
  assert.equal(overdue.saldoVencido, 30000);
  assert.equal(overdue.estadoCuenta, 'Moroso');
});
