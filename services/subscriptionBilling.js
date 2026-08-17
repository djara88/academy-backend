const supabase = require('../config/supabase');
const { getBillingQuote, GUARDIAN_ADDON_CLP } = require('./billingCatalog');

const addMonthsDate = (baseDate, months) => {
  const base = new Date(baseDate);
  const day = base.getUTCDate();
  const firstTarget = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(firstTarget.getUTCFullYear(), firstTarget.getUTCMonth() + 1, 0)).getUTCDate();
  firstTarget.setUTCDate(Math.min(day, lastDay));
  return firstTarget.toISOString().slice(0, 10);
};

const today = () => new Date().toISOString().slice(0, 10);
const activeGuardianLicense = (academy = {}) => academy.licencia_apoderados === true
  && (!academy.guardian_license_ends_at || String(academy.guardian_license_ends_at).slice(0, 10) >= today());

const activateGuardianAddonOnly = async (charge) => {
  const { data: current, error: currentError } = await supabase.from('academias')
    .select('id,licencia_apoderados,guardian_license_ends_at')
    .eq('id', charge.academia_id).single();
  if (currentError || !current) throw currentError || new Error('Academia no encontrada.');

  const months = Number(charge.billing_period_months) === 12 ? 12 : 1;
  const extensionBase = activeGuardianLicense(current) && current.guardian_license_ends_at
    ? new Date(`${current.guardian_license_ends_at}T12:00:00Z`)
    : new Date();
  const guardianLicenseEndsAt = addMonthsDate(extensionBase, months);
  const { error } = await supabase.from('academias').update({
    licencia_apoderados: true,
    guardian_price_clp: GUARDIAN_ADDON_CLP,
    guardian_license_ends_at: guardianLicenseEndsAt,
  }).eq('id', charge.academia_id);
  if (error) throw error;

  return {
    activated: true,
    addonOnly: true,
    guardianLicense: true,
    guardianLicenseEndsAt,
    guardianPriceClp: GUARDIAN_ADDON_CLP,
  };
};

const activateChargePlan = async (charge) => {
  if (!charge?.target_plan_code) {
    if (charge?.target_guardian_license === true) return activateGuardianAddonOnly(charge);
    return false;
  }

  const billingCycle = charge.billing_cycle === 'annual' ? 'annual' : 'monthly';
  const promotionCode = charge.promotion_code === 'founder' ? 'founder' : null;
  const targetGuardians = charge.target_guardian_license === true;
  const quote = getBillingQuote({
    planCode: charge.target_plan_code,
    billingCycle,
    promotionCode,
    guardians: targetGuardians,
  });
  if (!quote) throw new Error('El cobro no contiene un plan válido.');

  const { data: current, error: currentError } = await supabase.from('academias')
    .select('id,founder_number,promotion_ends_at,promotion_code,licencia_apoderados,guardian_license_ends_at,guardian_price_clp')
    .eq('id', charge.academia_id)
    .single();
  if (currentError || !current) throw currentError || new Error('Academia no encontrada.');

  let founderNumber = current.founder_number || null;
  let promotionEndsAt = current.promotion_ends_at || null;
  if (promotionCode === 'founder') {
    if (founderNumber && promotionEndsAt && promotionEndsAt < today()) {
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
  const baseMonthlyEquivalentClp = quote.billingCycle === 'annual'
    ? Math.round(quote.baseChargedNetClp / 12)
    : quote.baseChargedNetClp;
  const guardianWasAlreadyActive = activeGuardianLicense(current);
  const update = {
    plan: quote.plan.name,
    plan_codigo: quote.plan.code,
    max_profesores: quote.plan.professorLimit,
    max_jugadores: quote.plan.playerLimit || 100000,
    plan_price_clp: baseMonthlyEquivalentClp,
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

  if (targetGuardians) {
    update.licencia_apoderados = true;
    update.guardian_price_clp = GUARDIAN_ADDON_CLP;
    update.guardian_license_ends_at = nextBillingDate;
  } else if (!guardianWasAlreadyActive) {
    update.licencia_apoderados = false;
    update.guardian_price_clp = 0;
    update.guardian_license_ends_at = null;
  }

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
    monthlyEquivalentClp: baseMonthlyEquivalentClp,
    guardianLicense: targetGuardians || guardianWasAlreadyActive,
    guardianLicenseEndsAt: targetGuardians ? nextBillingDate : current.guardian_license_ends_at || null,
  };
};

module.exports = { activateChargePlan, activateGuardianAddonOnly, addMonthsDate };
