const supabase = require('../config/supabase');
const { recalculateFinancialStatus, todayInChile } = require('./monthlyBilling');

const money = (value) => Math.max(0, Number(value) || 0);
const sameMoney = (a, b) => Math.abs(money(a) - money(b)) < 0.005;

const getTournamentCharge = async ({ academyId, tournamentId, playerId }) => {
  const { data, error } = await supabase.from('cobros')
    .select('id,academia_id,jugador_id,torneo_id,inscripcion_id,sede_id,rama_id,concepto,tipo_concepto,monto,monto_pagado,estado,fecha_vencimiento')
    .eq('academia_id', academyId)
    .eq('torneo_id', tournamentId)
    .eq('jugador_id', playerId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
};

const ensureTournamentCharge = async ({ academyId, tournament, playerId, enrollmentId = null }) => {
  const price = money(tournament?.costo_inscripcion);
  if (price <= 0) return null;

  const dueDate = tournament?.fecha_inicio || todayInChile();
  const discipline = tournament?.ramas?.disciplina || tournament?.ramas?.nombre || 'Competencia';
  const concept = `Inscripción ${tournament?.nombre || 'competencia'} · ${discipline}`;
  let current = await getTournamentCharge({ academyId, tournamentId: tournament.id, playerId });

  if (current) {
    const alreadyPaid = money(current.monto_pagado);
    if (alreadyPaid > 0 && !sameMoney(current.monto, price)) {
      const error = new Error('El valor de esta competencia cambió después de registrar pagos. Dirección debe revisar la cuenta antes de modificar el cobro.');
      error.status = 409;
      error.code = 'TOURNAMENT_CHARGE_REVIEW_REQUIRED';
      throw error;
    }

    const changes = {
      concepto: concept,
      tipo_concepto: 'Torneo',
      monto: alreadyPaid > 0 ? current.monto : price,
      fecha_vencimiento: dueDate,
      inscripcion_id: enrollmentId || current.inscripcion_id || null,
      sede_id: tournament?.sede_id || current.sede_id || null,
      rama_id: tournament?.rama_id || current.rama_id || null,
    };
    if (current.estado === 'Anulado' && alreadyPaid <= 0) changes.estado = 'Pendiente';

    const { data, error } = await supabase.from('cobros').update(changes)
      .eq('id', current.id).eq('academia_id', academyId).select('*').single();
    if (error) throw error;
    current = data;
  } else {
    const { data, error } = await supabase.from('cobros').insert({
      academia_id: academyId,
      jugador_id: playerId,
      inscripcion_id: enrollmentId,
      sede_id: tournament?.sede_id || null,
      rama_id: tournament?.rama_id || null,
      torneo_id: tournament.id,
      concepto: concept,
      tipo_concepto: 'Torneo',
      monto: price,
      monto_pagado: 0,
      estado: 'Pendiente',
      fecha_vencimiento: dueDate,
    }).select('*').single();
    if (error) throw error;
    current = data;
  }

  await recalculateFinancialStatus(academyId);
  return current;
};

const ensureInstallmentSchedule = async ({ academyId, chargeId, installments, finalDueDate }) => {
  const total = Math.max(1, Math.min(24, Math.round(Number(installments) || 1)));
  const { data, error } = await supabase.rpc('generar_cuotas_cobro', {
    p_academia_id: academyId,
    p_cobro_id: chargeId,
    p_total_cuotas: total,
    p_fecha_primera: todayInChile(),
    p_fecha_final: finalDueDate || null,
  });
  if (error) throw error;
  return data;
};

const cancelTournamentCharge = async ({ academyId, tournamentId, playerId }) => {
  const current = await getTournamentCharge({ academyId, tournamentId, playerId });
  if (!current) return { cancelled: false, reason: 'not_found' };

  if (money(current.monto_pagado) > 0) {
    return {
      cancelled: false,
      review_required: true,
      charge_id: current.id,
      message: 'La participación fue rechazada, pero el cobro ya tiene pagos. Dirección debe revisar si corresponde devolución o mantener el abono.',
    };
  }

  const [{ error: chargeError }, { error: installmentError }] = await Promise.all([
    supabase.from('cobros').update({ estado: 'Anulado' }).eq('id', current.id).eq('academia_id', academyId),
    supabase.from('cobro_cuotas').update({ estado: 'Anulada', updated_at: new Date().toISOString() })
      .eq('cobro_id', current.id).eq('academia_id', academyId),
  ]);
  if (chargeError) throw chargeError;
  if (installmentError) throw installmentError;
  await recalculateFinancialStatus(academyId);
  return { cancelled: true, charge_id: current.id };
};

const syncTournamentBilling = async ({ academyId, tournament, playerId, enrollmentId = null, response, installments = null, pendingInstallments = false }) => {
  if (response === 'No') return cancelTournamentCharge({ academyId, tournamentId: tournament.id, playerId });
  if (response !== 'Si') return null;

  if (money(tournament?.costo_inscripcion) <= 0) {
    return cancelTournamentCharge({ academyId, tournamentId: tournament.id, playerId });
  }

  const charge = await ensureTournamentCharge({ academyId, tournament, playerId, enrollmentId });
  if (!charge || pendingInstallments) return { charge, schedule: null, pending_installments: pendingInstallments };

  const schedule = await ensureInstallmentSchedule({
    academyId,
    chargeId: charge.id,
    installments: Math.max(1, Number(installments) || 1),
    finalDueDate: tournament?.fecha_inicio || charge.fecha_vencimiento,
  });
  return { charge, schedule, pending_installments: false };
};

module.exports = {
  getTournamentCharge,
  ensureTournamentCharge,
  ensureInstallmentSchedule,
  cancelTournamentCharge,
  syncTournamentBilling,
};