const { PLAN_CODES, GUARDIAN_ADDON_CLP } = require('./planCatalog');

const VAT_RATE = 0.19;
const FOUNDER_MONTHS = 12;
const FOUNDER_SLOTS = 10;

const BILLING_PLANS = Object.freeze({
  [PLAN_CODES.FORMACION]: {
    code: PLAN_CODES.FORMACION, name: 'Formación', priceClp: 59000,
    founderPriceClp: 49000, professorLimit: 3, playerLimit: 100,
  },
  [PLAN_CODES.COMPETENCIA]: {
    code: PLAN_CODES.COMPETENCIA, name: 'Competencia', priceClp: 99000,
    founderPriceClp: 79000, professorLimit: 10, playerLimit: 300,
  },
  [PLAN_CODES.ALTO_RENDIMIENTO]: {
    code: PLAN_CODES.ALTO_RENDIMIENTO, name: 'Alto Rendimiento', priceClp: 149000,
    founderPriceClp: 119000, professorLimit: 30, playerLimit: null,
  },
});

const getBillingPlan = (code) => BILLING_PLANS[code] || null;
const gross = (netClp) => Math.round(Number(netClp || 0) * (1 + VAT_RATE));
const calculateGrossClp = ({ priceClp, guardians = false }) => gross(Number(priceClp || 0) + (guardians ? GUARDIAN_ADDON_CLP : 0));

const guardianAddonQuote = (billingCycle = 'monthly') => {
  const cycle = billingCycle === 'annual' ? 'annual' : 'monthly';
  const regularNetClp = GUARDIAN_ADDON_CLP * (cycle === 'annual' ? 12 : 1);
  const chargedNetClp = GUARDIAN_ADDON_CLP * (cycle === 'annual' ? 10 : 1);
  return {
    billingCycle: cycle,
    billingPeriodMonths: cycle === 'annual' ? 12 : 1,
    regularNetClp,
    chargedNetClp,
    regularGrossClp: gross(regularNetClp),
    chargedGrossClp: gross(chargedNetClp),
    discountGrossClp: Math.max(0, gross(regularNetClp) - gross(chargedNetClp)),
    monthlyEquivalentNetClp: cycle === 'annual' ? Math.round(chargedNetClp / 12) : GUARDIAN_ADDON_CLP,
  };
};

const getBillingQuote = ({ planCode, billingCycle = 'monthly', promotionCode = null, guardians = false }) => {
  const plan = getBillingPlan(planCode);
  if (!plan) return null;

  const cycle = billingCycle === 'annual' ? 'annual' : 'monthly';
  const promotion = promotionCode === 'founder' ? 'founder' : null;
  if (promotion && cycle !== 'monthly') {
    const error = new Error('El Precio Fundador no se acumula con el pago anual.');
    error.code = 'PROMOTION_NOT_STACKABLE';
    throw error;
  }

  const baseRegularNet = cycle === 'annual' ? plan.priceClp * 12 : plan.priceClp;
  const baseChargedNet = promotion === 'founder'
    ? plan.founderPriceClp
    : cycle === 'annual'
      ? plan.priceClp * 10
      : plan.priceClp;
  const months = cycle === 'annual' ? 12 : 1;
  const addon = guardians ? guardianAddonQuote(cycle) : {
    regularNetClp: 0, chargedNetClp: 0, regularGrossClp: 0, chargedGrossClp: 0,
    discountGrossClp: 0, monthlyEquivalentNetClp: 0,
  };
  const regularNet = baseRegularNet + addon.regularNetClp;
  const chargedNet = baseChargedNet + addon.chargedNetClp;

  return {
    plan,
    billingCycle: cycle,
    promotionCode: promotion,
    billingPeriodMonths: months,
    guardians: Boolean(guardians),
    baseRegularNetClp: baseRegularNet,
    baseChargedNetClp: baseChargedNet,
    guardianRegularNetClp: addon.regularNetClp,
    guardianChargedNetClp: addon.chargedNetClp,
    guardianChargedGrossClp: addon.chargedGrossClp,
    regularNetClp: regularNet,
    chargedNetClp: chargedNet,
    chargedGrossClp: gross(chargedNet),
    regularGrossClp: gross(regularNet),
    discountGrossClp: Math.max(0, gross(regularNet) - gross(chargedNet)),
    monthlyEquivalentNetClp: cycle === 'annual' ? Math.round(chargedNet / 12) : chargedNet,
  };
};

const publicPlanPricing = (plan) => ({
  ...plan,
  monthly: {
    netClp: plan.priceClp,
    grossClp: gross(plan.priceClp),
  },
  annual: {
    netClp: plan.priceClp * 10,
    grossClp: gross(plan.priceClp * 10),
    regularNetClp: plan.priceClp * 12,
    monthsIncluded: 12,
    monthsCharged: 10,
    equivalentMonthlyNetClp: Math.round((plan.priceClp * 10) / 12),
  },
  founder: {
    netClp: plan.founderPriceClp,
    grossClp: gross(plan.founderPriceClp),
    durationMonths: FOUNDER_MONTHS,
  },
});

module.exports = {
  BILLING_PLANS,
  VAT_RATE,
  GUARDIAN_ADDON_CLP,
  FOUNDER_MONTHS,
  FOUNDER_SLOTS,
  getBillingPlan,
  getBillingQuote,
  guardianAddonQuote,
  publicPlanPricing,
  calculateGrossClp,
};
