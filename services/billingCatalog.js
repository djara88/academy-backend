const { PLAN_CODES } = require('./planCatalog');

const VAT_RATE = 0.19;
const GUARDIAN_ADDON_CLP = 0;
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
const calculateGrossClp = ({ priceClp, guardians = false }) => {
  const netClp = Number(priceClp || 0) + (guardians ? GUARDIAN_ADDON_CLP : 0);
  return Math.round(netClp * (1 + VAT_RATE));
};

const getBillingQuote = ({ planCode, billingCycle = 'monthly', promotionCode = null }) => {
  const plan = getBillingPlan(planCode);
  if (!plan) return null;

  const cycle = billingCycle === 'annual' ? 'annual' : 'monthly';
  const promotion = promotionCode === 'founder' ? 'founder' : null;
  if (promotion && cycle !== 'monthly') {
    const error = new Error('El Precio Fundador no se acumula con el pago anual.');
    error.code = 'PROMOTION_NOT_STACKABLE';
    throw error;
  }

  const regularNet = cycle === 'annual' ? plan.priceClp * 12 : plan.priceClp;
  const chargedNet = promotion === 'founder'
    ? plan.founderPriceClp
    : cycle === 'annual'
      ? plan.priceClp * 10
      : plan.priceClp;
  const months = cycle === 'annual' ? 12 : 1;

  return {
    plan,
    billingCycle: cycle,
    promotionCode: promotion,
    billingPeriodMonths: months,
    regularNetClp: regularNet,
    chargedNetClp: chargedNet,
    chargedGrossClp: calculateGrossClp({ priceClp: chargedNet }),
    regularGrossClp: calculateGrossClp({ priceClp: regularNet }),
    discountGrossClp: Math.max(0, calculateGrossClp({ priceClp: regularNet }) - calculateGrossClp({ priceClp: chargedNet })),
    monthlyEquivalentNetClp: cycle === 'annual' ? Math.round(chargedNet / 12) : chargedNet,
  };
};

const publicPlanPricing = (plan) => ({
  ...plan,
  monthly: {
    netClp: plan.priceClp,
    grossClp: calculateGrossClp({ priceClp: plan.priceClp }),
  },
  annual: {
    netClp: plan.priceClp * 10,
    grossClp: calculateGrossClp({ priceClp: plan.priceClp * 10 }),
    regularNetClp: plan.priceClp * 12,
    monthsIncluded: 12,
    monthsCharged: 10,
    equivalentMonthlyNetClp: Math.round((plan.priceClp * 10) / 12),
  },
  founder: {
    netClp: plan.founderPriceClp,
    grossClp: calculateGrossClp({ priceClp: plan.founderPriceClp }),
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
  publicPlanPricing,
  calculateGrossClp,
};
