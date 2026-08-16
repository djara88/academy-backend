const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const {
  BILLING_PLANS,
  GUARDIAN_ADDON_CLP,
  VAT_RATE,
  FOUNDER_SLOTS,
  publicPlanPricing,
  getBillingQuote,
  getBillingPlan,
} = require('../services/billingCatalog');

const router = express.Router();
const mercadoPagoLink = () => String(process.env.MERCADO_PAGO_PAYMENT_LINK || 'https://link.mercadopago.cl/smproweb').trim();
const mercadoPagoConfigured = () => /^https:\/\/link\.mercadopago\.cl\/[A-Za-z0-9._-]+$/i.test(mercadoPagoLink());
const clean = (value, max = 160) => String(value || '').trim().replace(/[\r\n|]+/g, ' ').slice(0, max);
const today = () => new Date().toISOString().slice(0, 10);

const getPromotionState = async (academyId) => {
  const [{ data: academy, error: academyError }, { data: slots, error: slotError }] = await Promise.all([
    supabase.from('academias')
      .select('id,billing_cycle,billing_amount_clp,promotion_code,promotion_ends_at,founder_number,subscription_status')
      .eq('id', academyId).single(),
    supabase.from('syncademia_founder_slots')
      .select('slot_no,academia_id,reserved_until,activated_at')
      .order('slot_no'),
  ]);
  if (academyError) throw academyError;
  if (slotError) throw slotError;

  const now = Date.now();
  const freeSlots = (slots || []).filter((slot) => {
    if (!slot.academia_id) return true;
    if (slot.activated_at) return false;
    return slot.reserved_until && new Date(slot.reserved_until).getTime() < now;
  }).length;
  const founderActive = academy.promotion_code === 'founder'
    && academy.founder_number
    && academy.promotion_ends_at
    && academy.promotion_ends_at >= today();

  return {
    academy,
    founder: {
      available: Boolean(founderActive || freeSlots > 0),
      existingFounder: Boolean(founderActive),
      remainingSlots: freeSlots,
      totalSlots: FOUNDER_SLOTS,
      founderNumber: academy.founder_number || null,
      guaranteeEndsAt: academy.promotion_ends_at || null,
    },
  };
};

router.get('/plans', authMiddleware, async (req, res) => {
  try {
    const promotionState = await getPromotionState(req.user.academia_id);
    const plans = Object.values(BILLING_PLANS).map((plan) => {
      const pricing = publicPlanPricing(plan);
      return { ...pricing, grossClp: pricing.monthly.grossClp };
    });

    res.json({
      success: true,
      data: {
        plans,
        guardianAddon: { priceClp: GUARDIAN_ADDON_CLP, grossClp: 0, included: true },
        vatRate: VAT_RATE,
        founder: promotionState.founder,
        billingRules: {
          annualMonthsCharged: 10,
          annualMonthsIncluded: 12,
          founderDurationMonths: 12,
          discountsStackable: false,
        },
        gateway: {
          provider: 'Mercado Pago',
          configured: mercadoPagoConfigured(),
          manualVerification: true,
        },
        currentSubscription: req.subscription || null,
      },
    });
  } catch (error) {
    console.error('Error cargando planes:', error?.message || 'Error desconocido');
    res.status(500).json({ error: 'No fue posible cargar los planes.' });
  }
});

router.post('/checkout', authMiddleware, requireDirector, async (req, res) => {
  let charge = null;
  let founderSlot = null;
  try {
    if (!mercadoPagoConfigured()) {
      return res.status(503).json({
        error: 'El botón de Mercado Pago no está configurado correctamente.',
        code: 'MERCADOPAGO_NOT_CONFIGURED',
      });
    }

    const planCode = String(req.body.plan_code || '');
    const plan = getBillingPlan(planCode);
    if (!plan) return res.status(400).json({ error: 'Selecciona un plan válido.' });

    const billingCycle = req.body.billing_cycle === 'annual' ? 'annual' : 'monthly';
    const promotionCode = req.body.promotion_code === 'founder' ? 'founder' : null;
    let quote;
    try {
      quote = getBillingQuote({ planCode, billingCycle, promotionCode });
    } catch (quoteError) {
      return res.status(400).json({ error: quoteError.message, code: quoteError.code || 'INVALID_BILLING_OFFER' });
    }

    const promotionState = await getPromotionState(req.user.academia_id);
    if (promotionCode === 'founder') {
      const hasExpiredFounder = promotionState.academy.founder_number
        && promotionState.academy.promotion_ends_at
        && promotionState.academy.promotion_ends_at < today();
      if (hasExpiredFounder) {
        return res.status(409).json({
          error: 'Tu período de Precio Fundador de 12 meses ya terminó. Puedes continuar con precio mensual o anual vigente.',
          code: 'FOUNDER_EXPIRED',
        });
      }
      if (!promotionState.founder.available) {
        return res.status(409).json({
          error: 'Los 10 cupos de Precio Fundador ya fueron asignados.',
          code: 'FOUNDER_SOLD_OUT',
        });
      }
    }

    const label = promotionCode === 'founder'
      ? `${plan.name} · Precio Fundador`
      : billingCycle === 'annual'
        ? `${plan.name} · Anual (12 meses por el valor de 10)`
        : `${plan.name} · Mensual`;

    const { data: inserted, error: chargeError } = await supabase.from('plataforma_cobros').insert({
      academia_id: req.user.academia_id,
      concepto: `Suscripción Syncademia · ${label}`,
      subtotal_clp: quote.chargedGrossClp,
      addon_clp: 0,
      target_plan_code: plan.code,
      target_guardian_license: true,
      billing_cycle: quote.billingCycle,
      billing_period_months: quote.billingPeriodMonths,
      promotion_code: quote.promotionCode,
      discount_clp: quote.discountGrossClp,
      fecha_vencimiento: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      checkout_url: mercadoPagoLink(),
      notas: `Pago externo Mercado Pago. Neto: $${quote.chargedNetClp.toLocaleString('es-CL')} CLP. Total con IVA esperado: $${quote.chargedGrossClp.toLocaleString('es-CL')} CLP. ${quote.promotionCode === 'founder' ? 'Precio Fundador válido durante los primeros 12 meses desde su activación y no acumulable.' : quote.billingCycle === 'annual' ? 'Incluye 12 meses pagando el equivalente a 10 meses. No acumulable con Precio Fundador.' : ''}`.trim(),
      created_by: req.user.id,
    }).select().single();
    if (chargeError) throw chargeError;
    charge = inserted;

    if (promotionCode === 'founder') {
      const { data: slot, error: slotError } = await supabase.rpc('reservar_syncademia_founder_slot', {
        p_academia_id: req.user.academia_id,
        p_charge_id: charge.id,
      });
      if (slotError) throw slotError;
      founderSlot = Number(slot || 0) || null;
      if (!founderSlot) {
        await supabase.from('plataforma_cobros').delete().eq('id', charge.id).eq('academia_id', req.user.academia_id);
        charge = null;
        return res.status(409).json({
          error: 'Los 10 cupos de Precio Fundador acaban de ser asignados. Elige pago mensual o anual.',
          code: 'FOUNDER_SOLD_OUT',
        });
      }
      const { error: slotUpdateError } = await supabase.from('plataforma_cobros')
        .update({ founder_slot: founderSlot })
        .eq('id', charge.id)
        .eq('academia_id', req.user.academia_id);
      if (slotUpdateError) throw slotUpdateError;
    }

    res.status(201).json({
      success: true,
      data: {
        chargeId: charge.id,
        checkoutUrl: mercadoPagoLink(),
        amountClp: Number(charge.total_clp || quote.chargedGrossClp),
        netAmountClp: quote.chargedNetClp,
        planName: plan.name,
        guardianLicense: true,
        billingCycle: quote.billingCycle,
        promotionCode: quote.promotionCode,
        founderSlot,
        discountClp: quote.discountGrossClp,
        manualVerification: true,
        expiresAt: charge.fecha_vencimiento,
      },
    });
  } catch (error) {
    if (charge?.id && founderSlot) {
      await Promise.allSettled([
        supabase.from('syncademia_founder_slots').update({ academia_id: null, charge_id: null, reserved_until: null, updated_at: new Date().toISOString() })
          .eq('slot_no', founderSlot).eq('charge_id', charge.id).is('activated_at', null),
        supabase.from('plataforma_cobros').delete().eq('id', charge.id).eq('academia_id', req.user.academia_id).eq('estado', 'pendiente'),
      ]);
    }
    console.error('Error iniciando checkout Mercado Pago:', error?.message || 'Error desconocido');
    res.status(500).json({ error: 'No fue posible preparar el pago. Intenta nuevamente.' });
  }
});

router.patch('/payment-notice/:chargeId', authMiddleware, requireDirector, async (req, res) => {
  try {
    const { data: charge, error: findError } = await supabase.from('plataforma_cobros')
      .select('id,estado,notas')
      .eq('id', req.params.chargeId)
      .eq('academia_id', req.user.academia_id)
      .maybeSingle();

    if (findError) throw findError;
    if (!charge) return res.status(404).json({ error: 'Cobro no encontrado.' });
    if (charge.estado === 'pagado') return res.json({ success: true, alreadyPaid: true });

    const payer = clean(req.body.payer_name, 120);
    const reference = clean(req.body.reference, 120);
    const notice = [
      `Cliente informó pago Mercado Pago ${new Date().toISOString()}.`,
      payer ? `Pagador: ${payer}.` : null,
      reference ? `Referencia: ${reference}.` : null,
    ].filter(Boolean).join(' ');
    const notas = `${clean(charge.notas, 700)} ${notice}`.trim().slice(0, 1000);

    const { error } = await supabase.from('plataforma_cobros')
      .update({ notas, updated_at: new Date().toISOString() })
      .eq('id', charge.id)
      .eq('academia_id', req.user.academia_id);
    if (error) throw error;

    res.json({ success: true, status: 'pending_validation' });
  } catch (_error) {
    res.status(500).json({ error: 'No fue posible informar el pago.' });
  }
});

router.get('/payment-status', authMiddleware, requireDirector, async (req, res) => {
  try {
    const chargeId = String(req.query.chargeId || '');
    if (!chargeId) return res.status(400).json({ error: 'Cobro requerido.' });

    const { data, error } = await supabase.from('plataforma_cobros')
      .select('id,concepto,total_clp,estado,target_plan_code,target_guardian_license,pagado_at,fecha_vencimiento,notas,billing_cycle,billing_period_months,promotion_code,discount_clp,founder_slot')
      .eq('academia_id', req.user.academia_id)
      .eq('id', chargeId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Pago no encontrado.' });

    res.json({ success: true, data });
  } catch (_error) {
    res.status(500).json({ error: 'No fue posible consultar el pago.' });
  }
});

module.exports = router;
