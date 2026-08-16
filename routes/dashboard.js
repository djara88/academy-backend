const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { FEATURES, getAcademyEntitlements } = require('../services/planCatalog');
const { ensureMonthlyChargesForAcademy, todayInChile } = require('../services/monthlyBilling');

const router = express.Router();
const BILLING_CACHE_TTL_MS = Math.max(10_000, Number(process.env.DASHBOARD_BILLING_CACHE_TTL_MS || 60_000));
const billingCache = new Map();

const getBillingSnapshot = async (academyId) => {
  const now = Date.now();
  const cached = billingCache.get(academyId);
  if (cached?.data && cached.expiresAt > now) return cached.data;
  if (cached?.promise) return cached.promise;

  const promise = ensureMonthlyChargesForAcademy(academyId)
    .then((data) => {
      billingCache.set(academyId, { data, expiresAt: Date.now() + BILLING_CACHE_TTL_MS });
      return data;
    })
    .catch((error) => {
      billingCache.delete(academyId);
      throw error;
    });

  billingCache.set(academyId, { promise, expiresAt: now + BILLING_CACHE_TTL_MS });
  return promise;
};

router.get('/resumen', authMiddleware, requireDirector, async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const billing = await getBillingSnapshot(academyId);
    const today = billing.today || todayInChile();
    const monthStart = `${today.slice(0, 7)}-01`;
    const nextMonthDate = new Date(`${monthStart}T12:00:00Z`);
    nextMonthDate.setUTCMonth(nextMonthDate.getUTCMonth() + 1);
    const nextMonth = nextMonthDate.toISOString().slice(0, 10);

    const [academyResult, matchesResult, alertsResult, kpisResult] = await Promise.all([
      supabase.from('academias')
        .select('id,nombre,logo,logo_url,plan,plan_codigo,max_profesores,licencia_apoderados,estado')
        .eq('id', academyId)
        .single(),
      supabase.from('partidos')
        .select('id,rival,fecha,hora,hora_citacion,ubicacion,condicion,estado,categorias(nombre)')
        .eq('academia_id', academyId)
        .gte('fecha', today)
        .neq('estado', 'Jugado')
        .order('fecha')
        .order('hora')
        .limit(8),
      supabase.from('alertas_asistencia')
        .select('id,racha,ultima_ausencia,jugadores(id,nombre),categorias(id,nombre)')
        .eq('academia_id', academyId)
        .eq('activa', true)
        .order('detectada_at', { ascending: false })
        .limit(6),
      supabase.rpc('obtener_dashboard_kpis', {
        p_academia_id: academyId,
        p_month_start: monthStart,
        p_next_month: nextMonth,
        p_today: today,
      }),
    ]);

    const required = [academyResult, matchesResult, alertsResult, kpisResult];
    const failed = required.find((result) => result.error);
    if (failed) throw failed.error;

    const entitlements = getAcademyEntitlements(academyResult.data);
    const kpis = kpisResult.data || {};
    const income = Number(kpis.ingresos_mes || 0);
    const expenses = Number(kpis.egresos_mes || 0);

    res.json({
      success: true,
      data: {
        academia: {
          id: academyResult.data.id,
          nombre: academyResult.data.nombre,
          logo: academyResult.data.logo_url || academyResult.data.logo,
          estado: academyResult.data.estado,
        },
        plan: entitlements,
        kpis: {
          jugadores: Number(kpis.jugadores || 0),
          profesores: {
            activos: Number(kpis.profesores_activos || 0),
            limite: entitlements.limits.professors,
          },
          categorias: Number(kpis.categorias || 0),
          proximos_partidos: (matchesResult.data || []).length,
          asistencia_mes: kpis.asistencia_mes === null || kpis.asistencia_mes === undefined
            ? null
            : Number(kpis.asistencia_mes),
          ingresos_mes: income,
          egresos_mes: expenses,
          saldo_mes: income - expenses,
          por_cobrar: Number(kpis.por_cobrar || 0),
          cobros_vencidos: Number(kpis.cobros_vencidos || 0),
          uniformes_pendientes: Number(kpis.uniformes_pendientes || 0),
        },
        calendario_mensual: billing,
        prioridades: {
          alertas_asistencia: entitlements.features.includes(FEATURES.ATTENDANCE_ALERTS)
            ? alertsResult.data || []
            : [],
          categorias_sin_profesor: Array.isArray(kpis.categorias_sin_profesor)
            ? kpis.categorias_sin_profesor
            : [],
        },
        proximos_partidos: matchesResult.data || [],
      },
    });
  } catch (error) {
    console.error('Error al construir dashboard:', error?.message || error);
    res.status(500).json({ error: 'No fue posible cargar el resumen de dirección.' });
  }
});

module.exports = router;
