const { PLAN_CODES } = require('./planCatalog');

const VAT_RATE = 0.19;
// Portal de apoderados y WhatsApp individual forman parte de todos los planes.
// Se conserva la constante para compatibilidad con el código histórico, pero
// ya no representa un add-on facturable.
const GUARDIAN_ADDON_CLP = 0;

const BILLING_PLANS = Object.freeze({
  [PLAN_CODES.FORMACION]: {
    code: PLAN_CODES.FORMACION, name: 'Formación', priceClp: 59000,
    professorLimit: 3, playerLimit: 100,
  },
  [PLAN_CODES.COMPETENCIA]: {
    code: PLAN_CODES.COMPETENCIA, name: 'Competencia', priceClp: 99000,
    professorLimit: 10, playerLimit: 300,
  },
  [PLAN_CODES.ALTO_RENDIMIENTO]: {
    code: PLAN_CODES.ALTO_RENDIMIENTO, name: 'Alto Rendimiento', priceClp: 149000,
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
