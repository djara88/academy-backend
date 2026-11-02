// Precios en CLP netos. El checkout cobra IVA (19%) y redondea al peso.
const PRICE_CLP = 19990;
const VAT_RATE = 0.19;
const TOTAL_CLP = Math.round(PRICE_CLP * (1 + VAT_RATE));
const GUARDIAN_ADDON_CLP = 15000;
const GUARDIAN_TOTAL_CLP = Math.round(GUARDIAN_ADDON_CLP * (1 + VAT_RATE));
// Reuse the full-access code accepted by existing database constraints.
const offer = Object.freeze({
  code: 'alto_rendimiento', name: 'Lestra Deportivo', priceClp: PRICE_CLP,
  professorLimit: 30, playerLimit: null,
});
const monthly = { netClp: PRICE_CLP, grossClp: TOTAL_CLP };
const catalog = {
  plans: [{ ...offer, monthly }],
  guardianAddon: { included: false, priceClp: GUARDIAN_ADDON_CLP, grossClp: GUARDIAN_TOTAL_CLP, billingCycle: 'monthly' },
};
const monthlyQuote = {
  plan: offer, billingCycle: 'monthly', billingPeriodMonths: 1, promotionCode: null,
  guardians: false, baseChargedNetClp: PRICE_CLP, guardianChargedGrossClp: 0,
  chargedNetClp: PRICE_CLP, chargedGrossClp: TOTAL_CLP, discountGrossClp: 0,
};
// Until tax-document issuance is operational, keep online payment disabled (assisted sales).
const checkoutEnabled = () => process.env.LESTRA_DOCUMENT_ISSUANCE_READY === 'true';
module.exports = { offer, monthlyQuote, catalog, checkoutEnabled, PRICE_CLP, TOTAL_CLP, VAT_RATE, GUARDIAN_ADDON_CLP, GUARDIAN_TOTAL_CLP };
