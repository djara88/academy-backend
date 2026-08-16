const supabase = require('../config/supabase');

const todayInChile = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

const clampDay = (year, monthIndex, requestedDay) => {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return Math.min(Math.max(Number(requestedDay) || 1, 1), lastDay);
};

const periodStart = (dateText) => `${String(dateText).slice(0, 7)}-01`;

const dueDateForPeriod = (period, dueDay) => {
  const [year, month] = String(period).slice(0, 7).split('-').map(Number);
  const day = clampDay(year, month - 1, dueDay);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const monthLabel = (period) => {
  const date = new Date(`${period}T12:00:00Z`);
  const label = new Intl.DateTimeFormat('es-CL', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
  return label.charAt(0).toUpperCase() + label.slice(1);
};

const daysBetween = (from, to) => {
  const start = Date.parse(`${from}T12:00:00Z`);
  const end = Date.parse(`${to}T12:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 86400000);
};

const effectiveEnrollmentMonth = (player) => {
  const raw = player.fecha_matricula || player.created_at;
  if (!raw) return null;
  return `${String(raw).slice(0, 7)}-01`;
};

const recalculateFinancialStatus = async (academyId) => {
  const { error } = await supabase.rpc('recalcular_estado_financiero_academia', { p_academia_id: academyId });
  if (error) throw error;
};

const ensureMonthlyChargesForAcademy = async (academyId) => {
  const today = todayInChile();
  const currentPeriod = periodStart(today);

  const { data: academy, error: academyError } = await supabase.from('academias')
    .select('id,dia_vencimiento_mensualidad,dias_aviso_mensualidad')
    .eq('id', academyId)
    .single();
  if (academyError) throw academyError;

  const dueDay = Number(academy?.dia_vencimiento_mensualidad || 0);
  const warningDays = Math.max(0, Math.min(15, Number(academy?.dias_aviso_mensualidad ?? 3)));

  if (!dueDay) {
    await recalculateFinancialStatus(academyId);
    return { configured: false, today, period: currentPeriod, dueDate: null, warningDays, created: 0 };
  }

  const [playersResult, existingResult] = await Promise.all([
    supabase.from('jugadores')
      .select('id,nombre,monto_mensualidad,fecha_matricula,created_at,estado_matricula')
      .eq('academia_id', academyId),
    supabase.from('cobros')
      .select('jugador_id')
      .eq('academia_id', academyId)
      .eq('tipo_concepto', 'Mensualidad')
      .eq('periodo_mensualidad', currentPeriod)
      .neq('estado', 'Anulado'),
  ]);
  if (playersResult.error) throw playersResult.error;
  if (existingResult.error) throw existingResult.error;

  const existingPlayerIds = new Set((existingResult.data || []).map((row) => row.jugador_id));
  const dueDate = dueDateForPeriod(currentPeriod, dueDay);
  const rows = (playersResult.data || []).filter((player) => {
    if (existingPlayerIds.has(player.id)) return false;
    if ((Number(player.monto_mensualidad) || 0) <= 0) return false;
    const enrollmentMonth = effectiveEnrollmentMonth(player);
    if (enrollmentMonth && enrollmentMonth >= currentPeriod) return false;
    const status = String(player.estado_matricula || '').trim().toLowerCase();
    if (['inactiva', 'retirado', 'retirada', 'baja'].includes(status)) return false;
    return true;
  }).map((player) => ({
    academia_id: academyId,
    jugador_id: player.id,
    concepto: `Mensualidad ${monthLabel(currentPeriod)}`,
    tipo_concepto: 'Mensualidad',
    monto: Number(player.monto_mensualidad) || 0,
    monto_pagado: 0,
    estado: 'Pendiente',
    fecha_vencimiento: dueDate,
    periodo_mensualidad: currentPeriod,
    observaciones: 'Cobro mensual generado automáticamente por calendario de academia',
  }));

  let created = 0;
  if (rows.length) {
    const { data, error } = await supabase.from('cobros').insert(rows).select('id');
    if (error && error.code !== '23505') throw error;
    created = data?.length || 0;
  }

  await recalculateFinancialStatus(academyId);
  return { configured: true, today, period: currentPeriod, dueDate, warningDays, created };
};

const summarizeCharges = (charges = [], options = {}) => {
  const today = options.today || todayInChile();
  const warningDays = Math.max(0, Number(options.warningDays || 0));
  let overdue = 0;
  let upcoming = 0;
  let nextDue = null;

  for (const charge of charges) {
    if (charge.estado === 'Anulado') continue;
    const balance = Math.max(Number(charge.monto || 0) - Number(charge.monto_pagado || 0), 0);
    if (balance <= 0) continue;
    const due = charge.fecha_vencimiento ? String(charge.fecha_vencimiento).slice(0, 10) : null;
    if (due && due < today) overdue += balance;
    else {
      upcoming += balance;
      if (due && (!nextDue || due < nextDue)) nextDue = due;
    }
  }

  const daysToNextDue = nextDue ? daysBetween(today, nextDue) : null;
  return {
    saldoVencido: overdue,
    saldoPorVencer: upcoming,
    saldoPendiente: overdue + upcoming,
    proximoVencimiento: nextDue,
    diasParaProximoVencimiento: daysToNextDue,
    mostrarAlertaProximoPago: daysToNextDue !== null && daysToNextDue >= 0 && daysToNextDue <= warningDays,
    estadoCuenta: overdue > 0 ? 'Moroso' : (upcoming > 0 ? 'Por vencer' : 'Al Día'),
  };
};

module.exports = {
  todayInChile,
  dueDateForPeriod,
  ensureMonthlyChargesForAcademy,
  recalculateFinancialStatus,
  summarizeCharges,
};
