const { PLAN_CODES } = require('./planCatalog');

const VAT_RATE = 0.19;
const GUARDIAN_ADDON_CLP = 15000;

const BILLING_PLANS = Object.freeze({
  [PLAN_CODES.FORMACION]: {
    code: PLAN_CODES.FORMACION, name: 'Formación', priceClp: 30000,
    professorLimit: 3, playerLimit: 100,
  },
  [PLAN_CODES.COMPETENCIA]: {
    code: PLAN_CODES.COMPETENCIA, name: 'Competencia', priceClp: 60000,
    professorLimit: 10, playerLimit: 300,
  },
  [PLAN_CODES.ALTO_RENDIMIENTO]: {
    code: PLAN_CODES.ALTO_RENDIMIENTO, name: 'Alto Rendimiento', priceClp: 100000,
    professorLimit: 30, playerLimit: null,
  },
});

const getBillingPlan = (code) => BILLING_PLANS[code] || null;
const calculateGrossClp = ({ priceClp, guardians = false }) => {
  const netClp = Number(priceClp || 0) + (guardians ? GUARDIAN_ADDON_CLP : 0);
  return Math.round(netClp * (1 + VAT_RATE));
};

module.exports = {
  BILLING_PLANS, VAT_RATE, GUARDIAN_ADDON_CLP,
  getBillingPlan, calculateGrossClp,
};
