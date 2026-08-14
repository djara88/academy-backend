const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { getAcademyEntitlements } = require('../services/planCatalog');

const router = express.Router();
const todayInChile = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const sum = (rows, field) => (rows || []).reduce((total, row) => total + Number(row[field] || 0), 0);

router.get('/resumen', authMiddleware, requireDirector, async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const today = todayInChile();
    const monthStart = `${today.slice(0, 7)}-01`;
    const nextMonthDate = new Date(`${monthStart}T12:00:00Z`);
    nextMonthDate.setUTCMonth(nextMonthDate.getUTCMonth() + 1);
    const nextMonth = nextMonthDate.toISOString().slice(0, 10);

    const [academyResult, playersResult, professorsResult, categoriesResult, matchesResult, paymentsResult, expensesResult, chargesResult, alertsResult, uniformsResult, trainingsResult, assignmentsResult] = await Promise.all([
      supabase.from('academias').select('id,nombre,logo,logo_url,plan,plan_codigo,max_profesores,licencia_apoderados,estado').eq('id', academyId).single(),
      supabase.from('jugadores').select('id', { count: 'exact', head: true }).eq('academia_id', academyId),
      supabase.from('usuarios').select('id', { count: 'exact', head: true }).eq('academia_id', academyId).eq('rol', 'profesor').eq('activo', true),
      supabase.from('categorias').select('id,nombre').eq('academia_id', academyId).order('nombre'),
      supabase.from('partidos').select('id,rival,fecha,hora,hora_citacion,ubicacion,condicion,estado,categorias(nombre)')
        .eq('academia_id', academyId).gte('fecha', today).neq('estado', 'Jugado').order('fecha').order('hora').limit(8),
      supabase.from('pagos').select('monto,fecha_pago').eq('academia_id', academyId).gte('fecha_pago', `${monthStart}T00:00:00`).lt('fecha_pago', `${nextMonth}T00:00:00`),
      supabase.from('egresos').select('monto,fecha_gasto,anulado_at').eq('academia_id', academyId).gte('fecha_gasto', monthStart).lt('fecha_gasto', nextMonth).is('anulado_at', null),
      supabase.from('cobros').select('monto,monto_pagado,estado,fecha_vencimiento').eq('academia_id', academyId),
      supabase.from('alertas_asistencia').select('id,racha,ultima_ausencia,jugadores(id,nombre),categorias(id,nombre)')
        .eq('academia_id', academyId).eq('activa', true).order('detectada_at', { ascending: false }).limit(6),
      supabase.from('jugadores').select('estado_uniforme').eq('academia_id', academyId),
      supabase.from('entrenamientos').select('id').eq('academia_id', academyId).gte('fecha', monthStart).lt('fecha', nextMonth),
      supabase.from('profesor_categorias').select('categoria_id').eq('academia_id', academyId).eq('activo', true),
    ]);

    const required = [academyResult, playersResult, professorsResult, categoriesResult, matchesResult, paymentsResult, expensesResult, chargesResult, alertsResult, uniformsResult, trainingsResult, assignmentsResult];
    const failed = required.find((result) => result.error);
    if (failed) throw failed.error;

    const trainingIds = (trainingsResult.data || []).map((training) => training.id);
    const attendanceResult = trainingIds.length
      ? await supabase.from('asistencias').select('estado').in('entrenamiento_id', trainingIds)
      : { data: [], error: null };
    if (attendanceResult.error) throw attendanceResult.error;

    const attendance = attendanceResult.data || [];
    const attended = attendance.filter((item) => item.estado === 'Presente').length;
    const eligibleAttendance = attendance.filter((item) => ['Presente', 'Ausente', 'Justificado'].includes(item.estado)).length;
    const categoryIdsWithProfessor = new Set((assignmentsResult.data || []).map((item) => item.categoria_id));
    const categoriesWithoutProfessor = (categoriesResult.data || []).filter((category) => !categoryIdsWithProfessor.has(category.id));
    const pendingUniforms = (uniformsResult.data || []).filter((item) => !['entregado', 'completo'].includes(String(item.estado_uniforme || '').toLowerCase())).length;
    const pendingReceivables = (chargesResult.data || []).reduce((total, charge) => total + Math.max(Number(charge.monto || 0) - Number(charge.monto_pagado || 0), 0), 0);
    const overdueReceivables = (chargesResult.data || []).filter((charge) => charge.fecha_vencimiento && charge.fecha_vencimiento < today && Math.max(Number(charge.monto || 0) - Number(charge.monto_pagado || 0), 0) > 0).length;
    const entitlements = getAcademyEntitlements(academyResult.data);

    res.json({
      success: true,
      data: {
        academia: { id: academyResult.data.id, nombre: academyResult.data.nombre, logo: academyResult.data.logo_url || academyResult.data.logo, estado: academyResult.data.estado },
        plan: entitlements,
        kpis: {
          jugadores: playersResult.count || 0,
          profesores: { activos: professorsResult.count || 0, limite: entitlements.limits.professors },
          categorias: (categoriesResult.data || []).length,
          proximos_partidos: (matchesResult.data || []).length,
          asistencia_mes: eligibleAttendance ? Math.round((attended / eligibleAttendance) * 100) : null,
          ingresos_mes: sum(paymentsResult.data, 'monto'),
          egresos_mes: sum(expensesResult.data, 'monto'),
          saldo_mes: sum(paymentsResult.data, 'monto') - sum(expensesResult.data, 'monto'),
          por_cobrar: pendingReceivables,
          cobros_vencidos: overdueReceivables,
          uniformes_pendientes: pendingUniforms,
        },
        prioridades: {
          alertas_asistencia: alertsResult.data || [],
          categorias_sin_profesor: categoriesWithoutProfessor,
        },
        proximos_partidos: matchesResult.data || [],
      },
    });
  } catch (error) {
    console.error('Error al construir dashboard:', error);
    res.status(500).json({ error: 'No fue posible cargar el resumen de dirección.' });
  }
});

module.exports = router;
