const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { guardianLicenseIsActive, isTrialPlan } = require('../services/planCatalog');
const {
  BILLING_PLANS,
  GUARDIAN_ADDON_CLP,
  VAT_RATE,
  FOUNDER_SLOTS,
  publicPlanPricing,
  getBillingQuote,
  getBillingPlan,
  guardianAddonQuote,
  calculateGrossClp,
} = require('../services/billingCatalog');

const router = express.Router();
const mercadoPagoLink = () => String(process.env.MERCADO_PAGO_PAYMENT_LINK || 'https://link.mercadopago.cl/smproweb').trim();
const mercadoPagoConfigured = () => /^https:\/\/link\.mercadopago\.cl\/[A-Za-z0-9._-]+$/i.test(mercadoPagoLink());
const clean = (value, max = 160) => String(value || '').trim().replace(/[\r\n|]+/g, ' ').slice(0, max);
const today = () => new Date().toISOString().slice(0, 10);

const getPromotionState = async (academyId) => {
  const [{ data: academy, error: academyError }, { data: slots, error: slotError }] = await Promise.all([
    supabase.from('academias')
      .select('id,plan,plan_codigo,billing_cycle,billing_amount_clp,promotion_code,promotion_ends_at,founder_number,subscription_status,licencia_apoderados,guardian_price_clp,guardian_license_ends_at,trial_ends_at')
      .eq('id', academyId).single(),
    supabase.from('syncademia_founder_slots').select('slot_no,academia_id,reserved_until,activated_at').order('slot_no'),
  ]);
  if (academyError) throw academyError;
  if (slotError) throw slotError;
  const now = Date.now();
  const freeSlots = (slots || []).filter((slot) => !slot.academia_id || (!slot.activated_at && slot.reserved_until && new Date(slot.reserved_until).getTime() < now)).length;
  const founderActive = academy.promotion_code === 'founder' && academy.founder_number && academy.promotion_ends_at && academy.promotion_ends_at >= today();
  return { academy, founder: {
    available: Boolean(founderActive || freeSlots > 0), existingFounder: Boolean(founderActive), remainingSlots: freeSlots,
    totalSlots: FOUNDER_SLOTS, founderNumber: academy.founder_number || null, guaranteeEndsAt: academy.promotion_ends_at || null,
  } };
};

router.get('/plans', authMiddleware, async (req, res) => {
  try {
    const state = await getPromotionState(req.user.academia_id);
    const plans = Object.values(BILLING_PLANS).map((plan) => ({ ...publicPlanPricing(plan), grossClp: publicPlanPricing(plan).monthly.grossClp }));
    const monthly = guardianAddonQuote('monthly');
    const annual = guardianAddonQuote('annual');
    const trialIncluded = isTrialPlan(state.academy);
    res.json({ success: true, data: {
      plans,
      guardianAddon: {
        name: 'Apoderados PRO', priceClp: GUARDIAN_ADDON_CLP, grossClp: monthly.chargedGrossClp,
        included: false, trialIncluded: true, monthly, annual,
        features: ['Portal familiar', 'Estado de cuenta y medios de pago', 'Chat y WhatsApp individual', 'Privacidad y solicitudes', 'Solicitud de nuevas disciplinas'],
      },
      currentGuardianLicense: {
        active: guardianLicenseIsActive(state.academy), trialIncluded,
        endsAt: trialIncluded ? state.academy.trial_ends_at || null : state.academy.guardian_license_ends_at || null,
      },
      vatRate: VAT_RATE, founder: state.founder,
      billingRules: { annualMonthsCharged: 10, annualMonthsIncluded: 12, founderDurationMonths: 12, discountsStackable: false },
      gateway: { provider: 'Mercado Pago', configured: mercadoPagoConfigured(), manualVerification: true },
      currentSubscription: req.subscription || null,
    } });
  } catch (error) {
    console.error('Error cargando planes:', error?.message || 'Error desconocido');
    res.status(500).json({ error: 'No fue posible cargar los planes.' });
  }
});

router.post('/checkout', authMiddleware, requireDirector, async (req, res) => {
  let charge = null;
  let founderSlot = null;
  try {
    if (!mercadoPagoConfigured()) return res.status(503).json({ error: 'El botón de Mercado Pago no está configurado correctamente.', code: 'MERCADOPAGO_NOT_CONFIGURED' });
    const plan = getBillingPlan(String(req.body.plan_code || ''));
    if (!plan) return res.status(400).json({ error: 'Selecciona un plan válido.' });
    const billingCycle = req.body.billing_cycle === 'annual' ? 'annual' : 'monthly';
    const promotionCode = req.body.promotion_code === 'founder' ? 'founder' : null;
    const guardians = req.body.guardian_license === true;
    let quote;
    try { quote = getBillingQuote({ planCode: plan.code, billingCycle, promotionCode, guardians }); }
    catch (quoteError) { return res.status(400).json({ error: quoteError.message, code: quoteError.code || 'INVALID_BILLING_OFFER' }); }

    const state = await getPromotionState(req.user.academia_id);
    if (promotionCode === 'founder') {
      if (state.academy.founder_number && state.academy.promotion_ends_at && state.academy.promotion_ends_at < today()) return res.status(409).json({ error: 'Tu período de Precio Fundador de 12 meses ya terminó.', code: 'FOUNDER_EXPIRED' });
      if (!state.founder.available) return res.status(409).json({ error: 'Los 10 cupos de Precio Fundador ya fueron asignados.', code: 'FOUNDER_SOLD_OUT' });
    }

    const label = promotionCode === 'founder' ? `${plan.name} · Precio Fundador` : billingCycle === 'annual' ? `${plan.name} · Anual (12 meses por el valor de 10)` : `${plan.name} · Mensual`;
    const { data: inserted, error: chargeError } = await supabase.from('plataforma_cobros').insert({
      academia_id: req.user.academia_id,
      concepto: `Suscripción Syncademia · ${label}${guardians ? ' + Apoderados PRO' : ''}`,
      subtotal_clp: calculateGrossClp({ priceClp: quote.baseChargedNetClp }),
      addon_clp: quote.guardianChargedGrossClp,
      target_plan_code: plan.code,
      target_guardian_license: guardians,
      billing_cycle: quote.billingCycle,
      billing_period_months: quote.billingPeriodMonths,
      promotion_code: quote.promotionCode,
      discount_clp: quote.discountGrossClp,
      fecha_vencimiento: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
      checkout_url: mercadoPagoLink(),
      notas: `Pago externo Mercado Pago. Neto total: $${quote.chargedNetClp.toLocaleString('es-CL')} CLP. Total con IVA esperado: $${quote.chargedGrossClp.toLocaleString('es-CL')} CLP.${guardians ? ` Incluye Apoderados PRO: $${quote.guardianChargedNetClp.toLocaleString('es-CL')} netos.` : ''}`,
      created_by: req.user.id,
    }).select().single();
    if (chargeError) throw chargeError;
    charge = inserted;

    if (promotionCode === 'founder') {
      const { data: slot, error: slotError } = await supabase.rpc('reservar_syncademia_founder_slot', { p_academia_id: req.user.academia_id, p_charge_id: charge.id });
      if (slotError) throw slotError;
      founderSlot = Number(slot || 0) || null;
      if (!founderSlot) {
        await supabase.from('plataforma_cobros').delete().eq('id', charge.id).eq('academia_id', req.user.academia_id);
        return res.status(409).json({ error: 'Los cupos Fundador acaban de agotarse.', code: 'FOUNDER_SOLD_OUT' });
      }
      const { error: updateError } = await supabase.from('plataforma_cobros').update({ founder_slot: founderSlot }).eq('id', charge.id).eq('academia_id', req.user.academia_id);
      if (updateError) throw updateError;
    }

    return res.status(201).json({ success: true, data: {
      chargeId: charge.id, checkoutUrl: mercadoPagoLink(), amountClp: Number(charge.total_clp || quote.chargedGrossClp),
      netAmountClp: quote.chargedNetClp, planName: plan.name, guardianLicense: guardians,
      guardianAmountClp: quote.guardianChargedGrossClp, billingCycle: quote.billingCycle, promotionCode: quote.promotionCode,
      founderSlot, discountClp: quote.discountGrossClp, manualVerification: true, expiresAt: charge.fecha_vencimiento,
    } });
  } catch (error) {
    if (charge?.id && founderSlot) await Promise.allSettled([
      supabase.from('syncademia_founder_slots').update({ academia_id: null, charge_id: null, reserved_until: null, updated_at: new Date().toISOString() }).eq('slot_no', founderSlot).eq('charge_id', charge.id).is('activated_at', null),
      supabase.from('plataforma_cobros').delete().eq('id', charge.id).eq('academia_id', req.user.academia_id).eq('estado', 'pendiente'),
    ]);
    console.error('Error iniciando checkout:', error?.message || 'Error desconocido');
    return res.status(500).json({ error: 'No fue posible preparar el pago. Intenta nuevamente.' });
  }
});

router.post('/guardian-addon/checkout', authMiddleware, requireDirector, async (req, res) => {
  try {
    if (!mercadoPagoConfigured()) return res.status(503).json({ error: 'El botón de Mercado Pago no está configurado correctamente.', code: 'MERCADOPAGO_NOT_CONFIGURED' });
    const state = await getPromotionState(req.user.academia_id);
    if (isTrialPlan(state.academy)) return res.status(409).json({ error: 'Apoderados PRO ya está incluido durante tu prueba Full.', code: 'GUARDIAN_INCLUDED_IN_TRIAL' });
    if (state.academy.subscription_status !== 'active') return res.status(409).json({ error: 'Activa primero un plan de Syncademia.', code: 'BASE_PLAN_REQUIRED' });
    const billingCycle = req.body.billing_cycle === 'annual' ? 'annual' : 'monthly';
    const quote = guardianAddonQuote(billingCycle);
    const { data: charge, error } = await supabase.from('plataforma_cobros').insert({
      academia_id: req.user.academia_id,
      concepto: `Complemento Syncademia · Apoderados PRO · ${billingCycle === 'annual' ? 'Anual (12 meses pagando 10)' : 'Mensual'}`,
      subtotal_clp: 0, addon_clp: quote.chargedGrossClp, target_plan_code: null, target_guardian_license: true,
      billing_cycle: quote.billingCycle, billing_period_months: quote.billingPeriodMonths, promotion_code: null,
      discount_clp: quote.discountGrossClp, fecha_vencimiento: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
      checkout_url: mercadoPagoLink(),
      notas: `Apoderados PRO para toda la academia. Neto: $${quote.chargedNetClp.toLocaleString('es-CL')} CLP. Total con IVA: $${quote.chargedGrossClp.toLocaleString('es-CL')} CLP.`,
      created_by: req.user.id,
    }).select().single();
    if (error) throw error;
    return res.status(201).json({ success: true, data: {
      chargeId: charge.id, checkoutUrl: mercadoPagoLink(), amountClp: Number(charge.total_clp || quote.chargedGrossClp),
      netAmountClp: quote.chargedNetClp, planName: 'Apoderados PRO', guardianLicense: true,
      billingCycle: quote.billingCycle, promotionCode: null, discountClp: quote.discountGrossClp,
      manualVerification: true, expiresAt: charge.fecha_vencimiento,
    } });
  } catch (error) {
    console.error('Error preparando Apoderados PRO:', error?.message || 'Error desconocido');
    return res.status(500).json({ error: 'No fue posible preparar el pago de Apoderados PRO.' });
  }
});

router.patch('/payment-notice/:chargeId', authMiddleware, requireDirector, async (req, res) => {
  try {
    const { data: charge, error: findError } = await supabase.from('plataforma_cobros').select('id,estado,notas').eq('id', req.params.chargeId).eq('academia_id', req.user.academia_id).maybeSingle();
    if (findError) throw findError;
    if (!charge) return res.status(404).json({ error: 'Cobro no encontrado.' });
    if (charge.estado === 'pagado') return res.json({ success: true, alreadyPaid: true });
    const payer = clean(req.body.payer_name, 120);
    const reference = clean(req.body.reference, 120);
    const notice = [`Cliente informó pago Mercado Pago ${new Date().toISOString()}.`, payer ? `Pagador: ${payer}.` : null, reference ? `Referencia: ${reference}.` : null].filter(Boolean).join(' ');
    const { error } = await supabase.from('plataforma_cobros').update({ notas: `${clean(charge.notas, 700)} ${notice}`.trim().slice(0, 1000), updated_at: new Date().toISOString() }).eq('id', charge.id).eq('academia_id', req.user.academia_id);
    if (error) throw error;
    return res.json({ success: true, status: 'pending_validation' });
  } catch (_error) { return res.status(500).json({ error: 'No fue posible informar el pago.' }); }
});

router.get('/payment-status', authMiddleware, requireDirector, async (req, res) => {
  try {
    const chargeId = String(req.query.chargeId || '');
    if (!chargeId) return res.status(400).json({ error: 'Cobro requerido.' });
    const { data, error } = await supabase.from('plataforma_cobros')
      .select('id,concepto,total_clp,estado,target_plan_code,target_guardian_license,pagado_at,fecha_vencimiento,notas,billing_cycle,billing_period_months,promotion_code,discount_clp,founder_slot')
      .eq('academia_id', req.user.academia_id).eq('id', chargeId).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Pago no encontrado.' });
    return res.json({ success: true, data });
  } catch (_error) { return res.status(500).json({ error: 'No fue posible consultar el pago.' }); }
});

module.exports = router;
