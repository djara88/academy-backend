const supabase = require('../config/supabase');
const { getBillingQuote } = require('./billingCatalog');

const addMonthsDate = (baseDate, months) => {
  const base = new Date(baseDate);
  const day = base.getUTCDate();
  const firstTarget = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(firstTarget.getUTCFullYear(), firstTarget.getUTCMonth() + 1, 0)).getUTCDate();
  firstTarget.setUTCDate(Math.min(day, lastDay));
  return firstTarget.toISOString().slice(0, 10);
};

const activateChargePlan = async (charge) => {
  if (!charge?.target_plan_code) return false;

  const billingCycle = charge.billing_cycle === 'annual' ? 'annual' : 'monthly';
  const promotionCode = charge.promotion_code === 'founder' ? 'founder' : null;
  const quote = getBillingQuote({
    planCode: charge.target_plan_code,
    billingCycle,
    promotionCode,
  });
  if (!quote) throw new Error('El cobro no contiene un plan válido.');

  const { data: current, error: currentError } = await supabase.from('academias')
    .select('id,founder_number,promotion_ends_at,promotion_code')
    .eq('id', charge.academia_id)
    .single();
  if (currentError || !current) throw currentError || new Error('Academia no encontrada.');

  let founderNumber = current.founder_number || null;
  let promotionEndsAt = current.promotion_ends_at || null;
  if (promotionCode === 'founder') {
    if (founderNumber && promotionEndsAt && promotionEndsAt < new Date().toISOString().slice(0, 10)) {
      throw new Error('El período de Precio Fundador de esta academia ya finalizó.');
    }
    const { data: slot, error: slotError } = await supabase.rpc('activar_syncademia_founder_slot', {
      p_academia_id: charge.academia_id,
      p_charge_id: charge.id,
    });
    if (slotError) throw slotError;
    if (!slot) throw new Error('El cupo de Precio Fundador ya no está reservado para este cobro.');
    founderNumber = Number(slot);
    promotionEndsAt = promotionEndsAt || addMonthsDate(new Date(), 12);
  }

  const nextBillingDate = addMonthsDate(new Date(), quote.billingPeriodMonths);
  const update = {
    plan: quote.plan.name,
    plan_codigo: quote.plan.code,
    max_profesores: quote.plan.professorLimit,
    max_jugadores: quote.plan.playerLimit || 100000,
    licencia_apoderados: true,
    plan_price_clp: quote.monthlyEquivalentNetClp,
    guardian_price_clp: 0,
    billing_cycle: quote.billingCycle,
    billing_amount_clp: quote.chargedNetClp,
    promotion_code: promotionCode,
    promotion_ends_at: promotionEndsAt,
    founder_number: founderNumber,
    subscription_status: 'active',
    estado: 'Activa',
    blocked_at: null,
    blocked_reason: null,
    next_billing_date: nextBillingDate,
  };

  const { error } = await supabase.from('academias').update(update).eq('id', charge.academia_id);
  if (error) throw error;
  return {
    activated: true,
    billingCycle: quote.billingCycle,
    promotionCode,
    founderNumber,
    promotionEndsAt,
    nextBillingDate,
    billingAmountClp: quote.chargedNetClp,
    monthlyEquivalentClp: quote.monthlyEquivalentNetClp,
  };
};

module.exports = { activateChargePlan, addMonthsDate };
