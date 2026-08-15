const supabase = require('../config/supabase');
const { GUARDIAN_ADDON_CLP, getBillingPlan } = require('./billingCatalog');

const activateChargePlan = async (charge) => {
  if (!charge?.target_plan_code) return false;

  const plan = getBillingPlan(charge.target_plan_code);
  if (!plan) throw new Error('El cobro no contiene un plan válido.');

  const { error } = await supabase.from('academias').update({
    plan: plan.name,
    plan_codigo: plan.code,
    max_profesores: plan.professorLimit,
    max_jugadores: plan.playerLimit || 100000,
    licencia_apoderados: charge.target_guardian_license === true,
    plan_price_clp: plan.priceClp,
    guardian_price_clp: charge.target_guardian_license ? GUARDIAN_ADDON_CLP : 0,
    subscription_status: 'active',
    estado: 'Activa',
    blocked_at: null,
    blocked_reason: null,
    next_billing_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  }).eq('id', charge.academia_id);

  if (error) throw error;
  return true;
};

module.exports = { activateChargePlan };
