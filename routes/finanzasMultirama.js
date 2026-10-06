const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { createTenantRepository } = require('../services/tenantRepository');
const { requireTenantContext } = require('../middleware/tenantContext');
const { recalculateFinancialStatus, summarizeCharges, todayInChile } = require('../services/monthlyBilling');
const { getBranch, getStudentEnrollment, getStudentsForScope, safeText } = require('../services/branchContext');

const router = express.Router();
router.use(authMiddleware, requireTenantContext);

const money = (value) => Number(value || 0);
const fail = (result, context) => {
  if (result.error) throw new Error(`${context}: ${result.error.message}`);
  return result.data ?? null;
};
const list = (result, context) => fail(result, context) || [];
const branchParam = (req) => safeText(req.query?.rama_id || req.body?.rama_id, 80);
const keyFrom = (value) => safeText(value, 160) || null;
const normalizedText = (value) => String(value || '').trim();

const findIdempotentRow = async (table, academyId, key, select = '*') => {
  if (!key) return null;
  const { data, error } = await supabase.from(table).select(select)
    .eq('academia_id', academyId).eq('idempotency_key', key).maybeSingle();
  if (error) throw error;
  return data;
};

const sameBranchCharge = (existing, payload) => Boolean(existing)
  && String(existing.jugador_id || '') === String(payload.jugador_id || '')
  && String(existing.inscripcion_id || '') === String(payload.inscripcion_id || '')
  && String(existing.rama_id || '') === String(payload.rama_id || '')
  && normalizedText(existing.concepto) === normalizedText(payload.concepto)
  && normalizedText(existing.tipo_concepto) === normalizedText(payload.tipo_concepto)
  && money(existing.monto) === money(payload.monto)
  && String(existing.fecha_vencimiento || '') === String(payload.fecha_vencimiento || '')
  && normalizedText(existing.observaciones) === normalizedText(payload.observaciones);

const sameBranchExpense = (existing, payload) => Boolean(existing)
  && String(existing.rama_id || '') === String(payload.rama_id || '')
  && normalizedText(existing.concepto) === normalizedText(payload.concepto)
  && normalizedText(existing.categoria_gasto) === normalizedText(payload.categoria_gasto)
  && normalizedText(existing.centro_costo) === normalizedText(payload.centro_costo)
  && money(existing.monto) === money(payload.monto)
  && normalizedText(existing.metodo_pago) === normalizedText(payload.metodo_pago)
  && String(existing.fecha_gasto || '') === String(payload.fecha_gasto || '')
  && normalizedText(existing.observaciones) === normalizedText(payload.observaciones);

const idempotentConflict = (res) => res.status(409).json({
  success: false,
  code: 'IDEMPOTENCY_KEY_REUSED',
  error: 'Esta operación ya fue utilizada con datos diferentes. Genera una nueva operación antes de intentarlo otra vez.',
});

router.get('/resumen', async (req, res, next) => {
  const branchId = branchParam(req);
  if (!branchId) return next();
  try {
    const academyId = req.tenant.academyId;
    await getBranch(academyId, branchId);
    const [chargesResult, expensesResult, enrollmentsResult] = await Promise.all([
      supabase.from('cobros').select('id,jugador_id,monto,monto_pagado,estado,fecha_vencimiento').eq('academia_id', academyId).eq('rama_id', branchId),
      supabase.from('egresos').select('monto').eq('academia_id', academyId).eq('rama_id', branchId).is('anulado_at', null),
      supabase.from('inscripciones_deportivas').select('jugador_id').eq('academia_id', academyId).eq('rama_id', branchId).eq('estado', 'Activa'),
    ]);
    const charges = list(chargesResult, 'No se pudieron leer los cobros de la rama');
    const expenses = list(expensesResult, 'No se pudieron leer los egresos de la rama');
    const enrollments = list(enrollmentsResult, 'No se pudieron leer las inscripciones de la rama');
    const chargeIds = charges.map((item) => item.id);
    let payments = [];
    if (chargeIds.length) payments = list(await supabase.from('pagos').select('monto').eq('academia_id', academyId).in('cobro_id', chargeIds), 'No se pudieron leer los pagos de la rama');
    const today = todayInChile();
    const current = charges.filter((item) => !['Pagado', 'Anulado'].includes(item.estado));
    const totalReceipts = payments.reduce((sum, item) => sum + money(item.monto), 0);
    const totalPending = current.reduce((sum, item) => sum + Math.max(money(item.monto) - money(item.monto_pagado), 0), 0);
    const totalOverdue = current.reduce((sum, item) => item.fecha_vencimiento && item.fecha_vencimiento < today ? sum + Math.max(money(item.monto) - money(item.monto_pagado), 0) : sum, 0);
    const overdueStudents = new Set(current.filter((item) => item.jugador_id && item.fecha_vencimiento && item.fecha_vencimiento < today && money(item.monto) > money(item.monto_pagado)).map((item) => item.jugador_id));
    const activeStudents = new Set(enrollments.map((item) => item.jugador_id));
    const totalExpenses = expenses.reduce((sum, item) => sum + money(item.monto), 0);
    return res.json({ success: true, data: {
      totalIngresosReales: totalReceipts,
      totalPorCobrar: totalPending,
      totalVencido: totalOverdue,
      totalPorVencer: Math.max(totalPending - totalOverdue, 0),
      totalEgresos: totalExpenses,
      balanceNeto: totalReceipts - totalExpenses,
      totalAlumnos: activeStudents.size,
      alumnosMorosos: overdueStudents.size,
      tasaMorosidad: activeStudents.size ? Number(((overdueStudents.size / activeStudents.size) * 100).toFixed(1)) : 0,
      rama_id: branchId,
    } });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible cargar el resumen de la rama.' });
  }
});

router.get('/cuentas-corrientes', async (req, res, next) => {
  const branchId = branchParam(req);
  if (!branchId) return next();
  try {
    const academyId = req.tenant.academyId;
    await getBranch(academyId, branchId);
    const [students, chargesResult] = await Promise.all([
      getStudentsForScope({ academyId, branchId, playerSelect: 'id,nombre,foto_base64,foto_url,avatar_url,tutor_id,tutores:tutores!jugadores_tutor_id_fkey(nombre_completo,telefono)' }),
      supabase.from('cobros').select('*').eq('academia_id', academyId).eq('rama_id', branchId).order('fecha_vencimiento', { ascending: false }),
    ]);
    const charges = list(chargesResult, 'No se pudieron leer los cobros');
    const byStudent = new Map();
    for (const charge of charges) {
      if (!charge.jugador_id) continue;
      const current = byStudent.get(String(charge.jugador_id)) || [];
      current.push(charge); byStudent.set(String(charge.jugador_id), current);
    }
    const today = todayInChile();
    const data = students.map((student) => {
      const studentCharges = byStudent.get(String(student.id)) || [];
      const summary = summarizeCharges(studentCharges, { today, warningDays: 0 });
      return {
        ...student,
        cobros: studentCharges,
        deudaTotal: studentCharges.filter((item) => item.estado !== 'Anulado').reduce((sum, item) => sum + money(item.monto), 0),
        pagadoTotal: studentCharges.filter((item) => item.estado !== 'Anulado').reduce((sum, item) => sum + money(item.monto_pagado), 0),
        ...summary,
        saldoTotalPendiente: summary.saldoPendiente,
        saldoPendiente: summary.saldoVencido,
        alDia: summary.saldoVencido <= 0,
      };
    });
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible cargar las cuentas de la rama.' });
  }
});

router.get('/pagos', async (req, res, next) => {
  const branchId = branchParam(req);
  if (!branchId) return next();
  try {
    const academyId = req.tenant.academyId;
    await getBranch(academyId, branchId);
    const { data: charges, error: chargeError } = await supabase.from('cobros').select('id').eq('academia_id', academyId).eq('rama_id', branchId);
    if (chargeError) throw chargeError;
    const ids = (charges || []).map((item) => item.id);
    if (!ids.length) return res.json({ success: true, data: [] });
    const data = list(await supabase.from('pagos')
      .select('id,cobro_id,jugador_id,monto,metodo_pago,fecha_pago,observaciones,comprobante_ref,cobro:cobros!pagos_cobro_id_fkey(concepto,tipo_concepto,rama_id),jugador:jugadores!pagos_jugador_id_fkey(nombre)')
      .eq('academia_id', academyId).in('cobro_id', ids).order('fecha_pago', { ascending: false }), 'No se pudieron leer los pagos');
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible cargar los pagos de la rama.' });
  }
});

router.post('/cobros', async (req, res, next) => {
  const branchId = branchParam(req);
  if (!branchId) return next();
  try {
    const academyId = req.tenant.academyId;
    const playerId = safeText(req.body?.jugador_id, 80);
    const concept = safeText(req.body?.concepto, 300);
    const amount = money(req.body?.monto);
    if (!playerId || !concept || amount <= 0) return res.status(400).json({ error: 'Alumno, concepto y monto son obligatorios.' });
    const enrollment = await getStudentEnrollment(academyId, playerId, { branchId });
    const key = keyFrom(req.body?.idempotency_key);
    const payload = {
      academia_id: academyId,
      jugador_id: playerId,
      inscripcion_id: enrollment.id,
      sede_id: enrollment.sede_id,
      rama_id: enrollment.rama_id,
      concepto: concept,
      tipo_concepto: safeText(req.body?.tipo_concepto, 80) || 'Otro',
      monto: amount,
      monto_pagado: 0,
      estado: 'Pendiente',
      fecha_vencimiento: req.body?.fecha_vencimiento || todayInChile(),
      observaciones: safeText(req.body?.observaciones, 1000) || null,
      idempotency_key: key,
    };

    const existing = await findIdempotentRow('cobros', academyId, key);
    if (existing) {
      if (!sameBranchCharge(existing, payload)) return idempotentConflict(res);
      return res.json({ success: true, idempotent: true, data: existing });
    }

    const insertResult = await createTenantRepository({ academyId: academyId }).table('cobros').insert(payload).select('*').single();
    if (insertResult.error) {
      if (insertResult.error.code === '23505' && key) {
        const raced = await findIdempotentRow('cobros', academyId, key);
        if (raced && sameBranchCharge(raced, payload)) return res.json({ success: true, idempotent: true, data: raced });
        if (raced) return idempotentConflict(res);
      }
      throw insertResult.error;
    }
    await recalculateFinancialStatus(academyId);
    return res.status(201).json({ success: true, idempotent: false, data: insertResult.data });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible crear el cobro.' });
  }
});

router.get('/egresos', async (req, res, next) => {
  const branchId = branchParam(req);
  if (!branchId) return next();
  try {
    await getBranch(req.tenant.academyId, branchId);
    const data = list(await supabase.from('egresos').select('*,ramas(id,nombre,disciplina),sedes(id,nombre)')
      .eq('academia_id', req.tenant.academyId).eq('rama_id', branchId).is('anulado_at', null).order('fecha_gasto', { ascending: false }), 'No se pudieron leer los egresos');
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible cargar los egresos de la rama.' });
  }
});

router.post('/egresos', async (req, res, next) => {
  const branchId = branchParam(req);
  if (!branchId) return next();
  try {
    const academyId = req.tenant.academyId;
    const branch = await getBranch(academyId, branchId);
    const concept = safeText(req.body?.concepto, 300);
    const amount = money(req.body?.monto);
    if (!concept || amount <= 0) return res.status(400).json({ error: 'Concepto y monto son obligatorios.' });
    const key = keyFrom(req.body?.idempotency_key);
    const payload = {
      academia_id: academyId,
      sede_id: branch.sede_id,
      rama_id: branch.id,
      concepto: concept,
      categoria_gasto: safeText(req.body?.categoria_gasto, 100) || 'Otros',
      centro_costo: safeText(req.body?.centro_costo, 180) || branch.nombre,
      monto: amount,
      metodo_pago: safeText(req.body?.metodo_pago, 80) || 'Transferencia',
      fecha_gasto: req.body?.fecha_gasto || todayInChile(),
      observaciones: safeText(req.body?.observaciones, 1000) || null,
      idempotency_key: key,
    };

    const existing = await findIdempotentRow('egresos', academyId, key, '*,ramas(id,nombre,disciplina),sedes(id,nombre)');
    if (existing) {
      if (!sameBranchExpense(existing, payload)) return idempotentConflict(res);
      return res.json({ success: true, idempotent: true, data: existing });
    }

    const insertResult = await createTenantRepository({ academyId: academyId }).table('egresos').insert(payload).select('*,ramas(id,nombre,disciplina),sedes(id,nombre)').single();
    if (insertResult.error) {
      if (insertResult.error.code === '23505' && key) {
        const raced = await findIdempotentRow('egresos', academyId, key, '*,ramas(id,nombre,disciplina),sedes(id,nombre)');
        if (raced && sameBranchExpense(raced, payload)) return res.json({ success: true, idempotent: true, data: raced });
        if (raced) return idempotentConflict(res);
      }
      throw insertResult.error;
    }
    return res.status(201).json({ success: true, idempotent: false, data: insertResult.data });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible crear el egreso.' });
  }
});

router.get('/flujo-caja', async (req, res, next) => {
  const branchId = branchParam(req);
  if (!branchId) return next();
  try {
    const academyId = req.tenant.academyId;
    await getBranch(academyId, branchId);
    const [{ data: charges, error: chargeError }, expensesResult] = await Promise.all([
      supabase.from('cobros').select('id').eq('academia_id', academyId).eq('rama_id', branchId),
      supabase.from('egresos').select('id,concepto,monto,fecha_gasto,metodo_pago,categoria_gasto,centro_costo,ramas(id,nombre,disciplina)')
        .eq('academia_id', academyId).eq('rama_id', branchId).is('anulado_at', null),
    ]);
    if (chargeError) throw chargeError;
    const ids = (charges || []).map((item) => item.id);
    let payments = [];
    if (ids.length) payments = list(await supabase.from('pagos')
      .select('id,monto,fecha_pago,metodo_pago,observaciones,cobro:cobros!pagos_cobro_id_fkey(concepto),jugador:jugadores!pagos_jugador_id_fkey(nombre)')
      .eq('academia_id', academyId).in('cobro_id', ids), 'No se pudieron leer los ingresos');
    const expenses = list(expensesResult, 'No se pudieron leer los egresos');
    const incomeRows = payments.map((item) => ({ id:item.id,tipo:'Ingreso',concepto:`${item.cobro?.concepto || 'Pago'} - Alumno: ${item.jugador?.nombre || 'General'}`,monto:money(item.monto),fecha:item.fecha_pago,metodo:item.metodo_pago,categoria:'Recaudación' }));
    const expenseRows = expenses.map((item) => ({ id:item.id,tipo:'Egreso',concepto:item.concepto,monto:money(item.monto),fecha:item.fecha_gasto,metodo:item.metodo_pago,categoria:`${item.categoria_gasto} (${item.centro_costo || item.ramas?.nombre || 'Rama'})` }));
    const data = [...incomeRows, ...expenseRows].sort((a,b) => new Date(b.fecha || 0).getTime() - new Date(a.fecha || 0).getTime());
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible cargar el flujo de la rama.' });
  }
});

module.exports = router;
