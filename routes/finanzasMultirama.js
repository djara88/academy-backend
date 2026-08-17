const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { recalculateFinancialStatus, summarizeCharges, todayInChile } = require('../services/monthlyBilling');
const { getBranch, getStudentEnrollment, getStudentsForScope, safeText } = require('../services/branchContext');

const router = express.Router();
router.use(authMiddleware);

const money = (value) => Number(value || 0);
const fail = (result, context) => {
  if (result.error) throw new Error(`${context}: ${result.error.message}`);
  return result.data ?? null;
};
const list = (result, context) => fail(result, context) || [];
const branchParam = (req) => safeText(req.query?.rama_id || req.body?.rama_id, 80);

router.get('/resumen', async (req, res, next) => {
  const branchId = branchParam(req);
  if (!branchId) return next();
  try {
    const academyId = req.user.academia_id;
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
    const academyId = req.user.academia_id;
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
    const academyId = req.user.academia_id;
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
    const academyId = req.user.academia_id;
    const playerId = safeText(req.body?.jugador_id, 80);
    const concept = safeText(req.body?.concepto, 300);
    const amount = money(req.body?.monto);
    if (!playerId || !concept || amount <= 0) return res.status(400).json({ error: 'Alumno, concepto y monto son obligatorios.' });
    const enrollment = await getStudentEnrollment(academyId, playerId, { branchId });
    const { data, error } = await supabase.from('cobros').insert({
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
    }).select('*').single();
    if (error) throw error;
    await recalculateFinancialStatus(academyId);
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible crear el cobro.' });
  }
});

router.get('/egresos', async (req, res, next) => {
  const branchId = branchParam(req);
  if (!branchId) return next();
  try {
    await getBranch(req.user.academia_id, branchId);
    const data = list(await supabase.from('egresos').select('*,ramas(id,nombre,disciplina),sedes(id,nombre)')
      .eq('academia_id', req.user.academia_id).eq('rama_id', branchId).is('anulado_at', null).order('fecha_gasto', { ascending: false }), 'No se pudieron leer los egresos');
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible cargar los egresos de la rama.' });
  }
});

router.post('/egresos', async (req, res, next) => {
  const branchId = branchParam(req);
  if (!branchId) return next();
  try {
    const academyId = req.user.academia_id;
    const branch = await getBranch(academyId, branchId);
    const concept = safeText(req.body?.concepto, 300);
    const amount = money(req.body?.monto);
    if (!concept || amount <= 0) return res.status(400).json({ error: 'Concepto y monto son obligatorios.' });
    const { data, error } = await supabase.from('egresos').insert({
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
    }).select('*,ramas(id,nombre,disciplina),sedes(id,nombre)').single();
    if (error) throw error;
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible crear el egreso.' });
  }
});

router.get('/flujo-caja', async (req, res, next) => {
  const branchId = branchParam(req);
  if (!branchId) return next();
  try {
    const academyId = req.user.academia_id;
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
