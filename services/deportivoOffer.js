// Reuse the full-access code accepted by existing database constraints.
const PRICE_CLP = 19990;
const offer = Object.freeze({
  code: 'alto_rendimiento',
  name: 'Lestra Deportivo',
  priceClp: Math.round(PRICE_CLP / 1.19),
  professorLimit: 30,
  playerLimit: null,
});
const monthly = { netClp: offer.priceClp, grossClp: PRICE_CLP };
const catalog = {
  plans: [{ ...offer, monthly }],
  guardianAddon: { included: true, priceClp: 0, grossClp: 0 },
};
const monthlyQuote = {
  plan: offer, billingCycle: 'monthly', billingPeriodMonths: 1, promotionCode: null,
  guardians: true, baseChargedNetClp: offer.priceClp, guardianChargedGrossClp: 0,
  chargedNetClp: offer.priceClp, chargedGrossClp: PRICE_CLP, discountGrossClp: 0,
};
const checkoutEnabled = () => process.env.LESTRA_DOCUMENT_ISSUANCE_READY === 'true';
module.exports = { offer, monthlyQuote, catalog, checkoutEnabled, PRICE_CLP };
