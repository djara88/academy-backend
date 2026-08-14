const { PLAN_CODES } = require('./planCatalog');

const VAT_RATE = 0.19;
const GUARDIAN_ADDON_UF = 0.35;
const FALLBACK_UF_CLP = 40526;

const BILLING_PLANS = Object.freeze({
  [PLAN_CODES.FORMACION]: {
    code: PLAN_CODES.FORMACION, name: 'Formación', priceUf: 0.75,
    professorLimit: 3, playerLimit: 100,
  },
  [PLAN_CODES.COMPETENCIA]: {
    code: PLAN_CODES.COMPETENCIA, name: 'Competencia', priceUf: 1.5,
    professorLimit: 10, playerLimit: 300,
  },
  [PLAN_CODES.ALTO_RENDIMIENTO]: {
    code: PLAN_CODES.ALTO_RENDIMIENTO, name: 'Alto Rendimiento', priceUf: 2.5,
    professorLimit: 30, playerLimit: null,
  },
});

const getBillingPlan = (code) => BILLING_PLANS[code] || null;
const calculateGrossClp = ({ priceUf, guardians = false, ufValue }) => {
  const netUf = Number(priceUf || 0) + (guardians ? GUARDIAN_ADDON_UF : 0);
  return Math.round(netUf * Number(ufValue || FALLBACK_UF_CLP) * (1 + VAT_RATE));
};

module.exports = {
  BILLING_PLANS, VAT_RATE, GUARDIAN_ADDON_UF, FALLBACK_UF_CLP,
  getBillingPlan, calculateGrossClp,
};

