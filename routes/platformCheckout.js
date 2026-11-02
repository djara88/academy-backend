const express = require('express');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { offer, monthlyQuote, checkoutEnabled, PRICE_CLP } = require('../services/deportivoOffer');
const { PLATFORM_ACCESS_TOKEN, createPreference } = require('../services/mercadoPagoGateway');
const {
  getAcademyContract,
  getBillingProfile,
  saveBillingProfile,
  validateBillingProfile,
  billingSnapshot,
  getContractState,
  ensureRenewalChargeForAcademy,
} = require('../services/subscriptionContract');

const router = express.Router();
router.use(authMiddleware, requireDirector);
const addDays = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const chargeIdempotencyKey = (...parts) => `charge:${hash(parts.join('|'))}`;

const createOrReuseCharge = async ({ academyId, idempotencyKey, row }) => {
  const payload = {
    ...row,
    academia_id: academyId,
    idempotency_key: idempotencyKey,
    idempotency_fingerprint: hash(JSON.stringify(row)),
  };
  const { data, error } = await supabase.from('plataforma_cobros').insert(payload).select('*').single();
  if (!error) return { charge: data, created: true };
  if (error.code !== '23505') throw error;

  const { data: existing, error: existingError } = await supabase.from('plataforma_cobros')
    .select('*')
    .eq('academia_id', academyId)
    .eq('idempotency_key', idempotencyKey)
    .in('estado', ['pendiente', 'vencido', 'pagado'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingError) throw existingError;
  if (!existing) throw error;
  return { charge: existing, created: false };
};

const requireBillingProfile = async (academyId) => {
  const profile = await getBillingProfile(academyId);
  const validationError = profile ? validateBillingProfile(profile) : 'Completa primero los datos para Boleta o Factura.';
  if (validationError) {
    const error = new Error(validationError);
    error.status = 409;
    error.code = 'BILLING_PROFILE_REQUIRED';
    throw error;
  }
  return profile;
};

const createGatewayOrder = async ({ academyId, charge, title, amountClp, userId }) => {
  const token = PLATFORM_ACCESS_TOKEN();
  if (!token) {
    const error = new Error('Lestra todavía no tiene Checkout Pro de Mercado Pago configurado.');
    error.status = 503;
    throw error;
  }
  const { data: reusable, error: reusableError } = await supabase.from('payment_gateway_orders').select('*')
    .eq('scope', 'plataforma').eq('plataforma_cobro_id', charge.id).in('status', ['created', 'pending'])
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (reusableError) throw reusableError;
  if (reusable?.checkout_url) return reusable;

  const idempotencyKey = `platform-checkout:${charge.id}`;
  const externalReference = `lestra:plataforma:${crypto.randomUUID()}`;
  const { data: order, error } = await supabase.from('payment_gateway_orders').insert({
    scope: 'plataforma', academia_id: academyId, plataforma_cobro_id: charge.id,
    external_reference: externalReference, amount_expected: amountClp, status: 'created',
    created_by: userId, idempotency_key: idempotencyKey, metadata: { title },
  }).select('*').single();
  if (error) {
    if (error.code === '23505') {
      const { data: duplicate, error: duplicateError } = await supabase.from('payment_gateway_orders').select('*')
        .eq('academia_id', academyId).eq('idempotency_key', idempotencyKey)
        .in('status', ['created', 'pending']).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (duplicateError) throw duplicateError;
      if (duplicate?.checkout_url) return duplicate;
      if (duplicate) throw Object.assign(new Error('El checkout ya se está preparando. Reintenta en unos segundos.'), { status: 409, code: 'CHECKOUT_IN_PROGRESS' });
    }
    throw error;
  }
  try {
    const preference = await createPreference({
      accessToken: token, externalReference, title, amountClp, orderId: order.id,
      metadata: { scope: 'plataforma', academia_id: academyId, plataforma_cobro_id: charge.id },
    });
    const checkoutUrl = preference?.init_point || preference?.sandbox_init_point;
    if (!preference?.id || !checkoutUrl) throw new Error('Mercado Pago no devolvió una URL de checkout.');
    const { data: updated, error: updateError } = await supabase.from('payment_gateway_orders').update({
      preference_id: String(preference.id), checkout_url: checkoutUrl, updated_at: new Date().toISOString(),
    }).eq('id', order.id).select('*').single();
    if (updateError) throw updateError;
    return updated;
  } catch (error) {
    await supabase.from('payment_gateway_orders').update({
      status: 'error', metadata: { title, error: String(error.message || error).slice(0, 500) }, updated_at: new Date().toISOString(),
    }).eq('id', order.id);
    throw error;
  }
};

const requireIssuance = (_req, res, next) => checkoutEnabled() ? next() :
  res.status(503).json({ code: 'ASSISTED_SALES', error: 'Contacta a Lestra para coordinar la contratación.' });

router.get('/contract', async (req, res) => {
  try {
    const data = await getContractState(req.user.academia_id);
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error cargando contrato Lestra:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible cargar el contrato de Lestra.' });
  }
});

router.put('/billing-profile', async (req, res) => {
  try {
    const data = await saveBillingProfile({ academyId: req.user.academia_id, userId: req.user.id, payload: req.body || {} });
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible guardar los datos de facturación.', code: error?.code });
  }
});

router.post(['/change-request', '/guardian-addon'], (_req, res) => {
  res.status(410).json({ error: 'El plan mensual incluye todos los módulos y el acceso de apoderados.' });
});

router.post('/plan', requireIssuance, async (req, res) => {
  let charge = null;

  try {
    const academy = await getAcademyContract(req.user.academia_id);
    if (academy.contract_locked_at) {
      return res.status(409).json({
        error: 'Tu plan ya forma parte de un contrato activo. Para cambiarlo debes enviar una solicitud a Lestra.',
        code: 'PLAN_CHANGE_APPROVAL_REQUIRED',
      });
    }
    if (req.body?.plan_code !== offer.code || req.body?.billing_cycle !== 'monthly' || req.body?.promotion_code || req.body?.guardian_license !== true) {
      return res.status(400).json({ error: 'Actualiza la página para contratar el plan mensual vigente.' });
    }
    if (req.body.billing_profile) await saveBillingProfile({ academyId: academy.id, userId: req.user.id, payload: req.body.billing_profile });
    const profile = await requireBillingProfile(academy.id);
    const quote = monthlyQuote;
    const plan = offer;
    const guardians = true;
    const initialKey = chargeIdempotencyKey('deportivo-monthly-v1', academy.id);
    const reserved = await createOrReuseCharge({
      academyId: academy.id,
      idempotencyKey: initialKey,
      row: {
        concepto: 'Lestra Deportivo · Mensual',
        subtotal_clp: PRICE_CLP,
        addon_clp: quote.guardianChargedGrossClp,
        target_plan_code: plan.code,
        target_guardian_license: guardians,
        billing_cycle: quote.billingCycle,
        billing_period_months: quote.billingPeriodMonths,
        promotion_code: quote.promotionCode,
        discount_clp: quote.discountGrossClp,
        fecha_vencimiento: addDays(3),
        charge_kind: 'initial',
        billing_document_type: profile.documento_tipo,
        billing_snapshot: billingSnapshot(profile),
        notas: `Checkout Pro Mercado Pago. Documento solicitado: ${profile.documento_tipo}. Neto total: ${quote.chargedNetClp.toLocaleString('es-CL')} CLP. Total con IVA esperado: ${quote.chargedGrossClp.toLocaleString('es-CL')} CLP.`,
        created_by: req.user.id,
      },
    });
    charge = reserved.charge;
    charge.__created_now = reserved.created;

    const amount = Number(charge.total_clp);
    if (amount !== PRICE_CLP) throw new Error('El cobro no coincide con el precio del plan.');
    const order = await createGatewayOrder({ academyId: academy.id, charge, title: charge.concepto, amountClp: amount, userId: req.user.id });
    await supabase.from('plataforma_cobros').update({ checkout_url: order.checkout_url, referencia: order.external_reference, updated_at: new Date().toISOString() }).eq('id', charge.id);
    return res.status(201).json({ success: true, data: {
      chargeId: charge.id, orderId: order.id, checkoutUrl: order.checkout_url, amountClp: amount,
      netAmountClp: quote.chargedNetClp, planName: plan.name, guardianLicense: guardians,
      billingCycle: quote.billingCycle, promotionCode: quote.promotionCode,
      discountClp: quote.discountGrossClp, documentType: profile.documento_tipo, manualVerification: false,
    } });
  } catch (error) {
    if (charge?.id) {
      if (charge.__created_now && !charge.checkout_url) await supabase.from('plataforma_cobros').delete().eq('id', charge.id).eq('estado', 'pendiente');
    }
    console.error('Error preparando suscripción Checkout Pro:', error?.message || error);
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible preparar el pago.', code: error?.code || undefined });
  }
});

router.post('/renewal/checkout', requireIssuance, async (req, res) => {
  try {
    const academy = await getAcademyContract(req.user.academia_id);
    if (!academy.contract_locked_at) return res.status(409).json({ error: 'No existe un contrato activo para renovar.', code: 'CONTRACT_NOT_LOCKED' });
    const profile = await requireBillingProfile(academy.id);
    const charge = await ensureRenewalChargeForAcademy(academy);
    if (!charge) return res.status(409).json({ error: `Tu próxima renovación es el ${academy.next_billing_date || 'próximo ciclo'}. El pago se habilita 7 días antes.`, code: 'RENEWAL_NOT_DUE' });
    if (!['pendiente', 'vencido'].includes(charge.estado)) return res.status(409).json({ error: 'La renovación ya no está disponible.' });
    if (Number(charge.total_clp) !== PRICE_CLP) return res.status(409).json({ error: 'Contacta a Lestra para revisar tu renovación anterior.' });
    const snapshot = billingSnapshot(profile);
    const { data: refreshed, error: refreshError } = await supabase.from('plataforma_cobros').update({
      billing_document_type: profile.documento_tipo,
      billing_snapshot: snapshot,
      updated_at: new Date().toISOString(),
    }).eq('id', charge.id).select('*').single();
    if (refreshError) throw refreshError;
    const order = await createGatewayOrder({ academyId: academy.id, charge: refreshed, title: refreshed.concepto, amountClp: Number(refreshed.total_clp), userId: req.user.id });
    await supabase.from('plataforma_cobros').update({ checkout_url: order.checkout_url, referencia: order.external_reference, updated_at: new Date().toISOString() }).eq('id', refreshed.id);
    return res.status(201).json({ success: true, data: { chargeId: refreshed.id, orderId: order.id, checkoutUrl: order.checkout_url, amountClp: Number(refreshed.total_clp), documentType: profile.documento_tipo } });
  } catch (error) {
    console.error('Error preparando renovación Lestra:', error?.message || error);
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible preparar la renovación.', code: error?.code });
  }
});

module.exports = router;
