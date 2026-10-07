const express = require('express');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { isTrialPlan } = require('../services/planCatalog');
const { getBillingPlan, getBillingQuote, guardianAddonQuote, calculateGrossClp } = require('../services/billingCatalog');
const { PLATFORM_ACCESS_TOKEN, createPreference } = require('../services/mercadoPagoGateway');
const { requestIdempotencyKey, idempotencyFingerprint } = require('../services/idempotency');
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
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const clean = (value, max = 500) => String(value ?? '').trim().replace(/[\r\n|]+/g, ' ').slice(0, max);

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getActiveGatewayOrder = async (chargeId) => {
  const { data, error } = await supabase.from('payment_gateway_orders').select('*')
    .eq('scope', 'plataforma')
    .eq('plataforma_cobro_id', chargeId)
    .in('status', ['created', 'pending'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
};

const waitForGatewayOrder = async (chargeId, attempts = 12) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const order = await getActiveGatewayOrder(chargeId);
    if (order?.checkout_url) return order;
    if (!order || order.status === 'error' || order.status === 'cancelled') return null;
    await sleep(150);
  }
  return null;
};

const checkoutPreparingError = () => Object.assign(
  new Error('El checkout ya se está preparando. Reintenta la misma operación en unos segundos.'),
  { status: 409, code: 'CHECKOUT_PREPARING' },
);

const createGatewayOrder = async ({ academyId, charge, title, amountClp, userId }) => {
  const token = PLATFORM_ACCESS_TOKEN();
  if (!token) {
    const error = new Error('Lestra todavía no tiene Checkout Pro de Mercado Pago configurado.');
    error.status = 503;
    throw error;
  }

  const reusable = await getActiveGatewayOrder(charge.id);
  if (reusable?.checkout_url) return reusable;
  if (reusable) {
    const ageMs = Date.now() - new Date(reusable.created_at).getTime();
    if (Number.isFinite(ageMs) && ageMs < 120000) {
      const ready = await waitForGatewayOrder(charge.id);
      if (ready?.checkout_url) return ready;
      throw checkoutPreparingError();
    }
    const { error: staleError } = await supabase.from('payment_gateway_orders')
      .update({
        status: 'error',
        metadata: { ...(reusable.metadata || {}), error: 'stale checkout claim recovered' },
        updated_at: new Date().toISOString(),
      })
      .eq('id', reusable.id)
      .in('status', ['created', 'pending']);
    if (staleError) throw staleError;
  }

  const externalReference = `lestra:plataforma:${crypto.randomUUID()}`;
  const { data: order, error } = await supabase.from('payment_gateway_orders').insert({
    scope: 'plataforma', academia_id: academyId, plataforma_cobro_id: charge.id,
    external_reference: externalReference, amount_expected: amountClp, status: 'created',
    created_by: userId, metadata: { title },
  }).select('*').single();

  if (error) {
    if (error.code === '23505') {
      const ready = await waitForGatewayOrder(charge.id);
      if (ready?.checkout_url) return ready;
      throw checkoutPreparingError();
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

const reserveFounder = async (charge) => {
  const { data: slot, error } = await supabase.rpc('reservar_syncademia_founder_slot', { p_academia_id: charge.academia_id, p_charge_id: charge.id });
  if (error) throw error;
  const number = Number(slot || 0) || null;
  if (!number) {
    const slotError = new Error('Los 10 cupos de Precio Fundador ya fueron asignados.');
    slotError.status = 409;
    slotError.code = 'FOUNDER_SOLD_OUT';
    throw slotError;
  }
  const { error: updateError } = await supabase.from('plataforma_cobros').update({ founder_slot: number }).eq('id', charge.id);
  if (updateError) throw updateError;
  return number;
};

const invalidatePreviousInitialCheckouts = async (academyId, createdBefore = null) => {
  let chargeQuery = supabase.from('plataforma_cobros').select('id')
    .eq('academia_id', academyId).eq('estado', 'pendiente').in('charge_kind', ['manual', 'initial']).not('target_plan_code', 'is', null);
  if (createdBefore) chargeQuery = chargeQuery.lt('created_at', createdBefore);
  const { data: charges, error } = await chargeQuery;
  if (error) throw error;
  const ids = (charges || []).map((row) => row.id);
  if (!ids.length) return;
  const now = new Date().toISOString();
  const { error: orderError } = await supabase.from('payment_gateway_orders').update({ status: 'cancelled', updated_at: now })
    .eq('scope', 'plataforma').in('plataforma_cobro_id', ids).in('status', ['created', 'pending']);
  if (orderError) throw orderError;
  const { error: founderError } = await supabase.from('syncademia_founder_slots').update({
    academia_id: null,
    charge_id: null,
    reserved_until: null,
    updated_at: now,
  }).in('charge_id', ids).is('activated_at', null);
  if (founderError) throw founderError;
  const { error: chargeError } = await supabase.from('plataforma_cobros').update({ estado: 'anulado', updated_at: now }).in('id', ids);
  if (chargeError) throw chargeError;
};

const findOpenPlatformCharge = async (academyId, chargeKind) => {
  const { data, error } = await supabase.from('plataforma_cobros').select('*')
    .eq('academia_id', academyId)
    .eq('charge_kind', chargeKind)
    .in('estado', ['pendiente', 'vencido'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
};

const findIdempotentPlatformCharge = async (academyId, key) => {
  if (!key) return null;
  const { data, error } = await supabase.from('plataforma_cobros').select('*')
    .eq('academia_id', academyId)
    .eq('idempotency_key', key)
    .in('estado', ['pendiente', 'vencido', 'pagado'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
};

const assertCheckoutFingerprint = (charge, fingerprint) => {
  if (charge?.idempotency_fingerprint && charge.idempotency_fingerprint !== fingerprint) {
    const error = new Error('La misma clave de operación ya fue usada con una selección de checkout distinta.');
    error.status = 409;
    error.code = 'IDEMPOTENCY_KEY_REUSED';
    throw error;
  }
};

const cancelOpenAddonCheckout = async (academyId, chargeId) => {
  if (!chargeId) return;
  const now = new Date().toISOString();
  const { error: orderError } = await supabase.from('payment_gateway_orders')
    .update({ status: 'cancelled', updated_at: now })
    .eq('scope', 'plataforma')
    .eq('plataforma_cobro_id', chargeId)
    .in('status', ['created', 'pending']);
  if (orderError) throw orderError;
  const { error: chargeError } = await supabase.from('plataforma_cobros')
    .update({ estado: 'anulado', updated_at: now })
    .eq('id', chargeId)
    .eq('academia_id', academyId)
    .in('estado', ['pendiente', 'vencido']);
  if (chargeError) throw chargeError;
};

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

router.post('/change-request', async (req, res) => {
  try {
    const academy = await getAcademyContract(req.user.academia_id);
    if (!academy.contract_locked_at) return res.status(409).json({ error: 'Todavía no existe un contrato pagado que modificar.', code: 'CONTRACT_NOT_LOCKED' });
    const plan = getBillingPlan(String(req.body?.plan_code || ''));
    if (!plan) return res.status(400).json({ error: 'Selecciona un plan válido.' });
    const cycle = req.body?.billing_cycle === 'annual' ? 'annual' : 'monthly';
    const guardians = req.body?.guardian_license === true;
    const unchanged = plan.code === academy.plan_codigo && cycle === (academy.billing_cycle === 'annual' ? 'annual' : 'monthly') && guardians === Boolean(academy.licencia_apoderados);
    if (unchanged) return res.status(400).json({ error: 'La solicitud coincide con tu contrato actual.' });
    const { data: existing, error: existingError } = await supabase.from('subscription_change_requests').select('id,status')
      .eq('academia_id', academy.id).in('status', ['pending', 'approved']).limit(1).maybeSingle();
    if (existingError) throw existingError;
    if (existing) return res.status(409).json({ error: 'Ya existe una solicitud de cambio en revisión.', code: 'CHANGE_REQUEST_EXISTS' });
    const { data, error } = await supabase.from('subscription_change_requests').insert({
      academia_id: academy.id,
      current_plan_code: academy.plan_codigo,
      current_billing_cycle: academy.billing_cycle === 'annual' ? 'annual' : 'monthly',
      current_guardian_license: Boolean(academy.licencia_apoderados),
      requested_plan_code: plan.code,
      requested_billing_cycle: cycle,
      requested_guardian_license: guardians,
      reason: clean(req.body?.reason, 1000) || null,
      effective_from: academy.next_billing_date || null,
      requested_by: req.user.id,
    }).select('*').single();
    if (error) throw error;
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible solicitar el cambio de plan.', code: error?.code });
  }
});

router.post('/plan', async (req, res) => {
  let charge = null;
  let founderSlot = null;
  let ownsCharge = false;
  const operationStartedAt = new Date().toISOString();

  try {
    const academy = await getAcademyContract(req.user.academia_id);
    if (academy.contract_locked_at) {
      return res.status(409).json({
        error: 'Tu plan ya forma parte de un contrato activo. Para cambiarlo debes enviar una solicitud a Lestra.',
        code: 'PLAN_CHANGE_APPROVAL_REQUIRED',
      });
    }

    if (req.body?.billing_profile) await saveBillingProfile({ academyId: academy.id, userId: req.user.id, payload: req.body.billing_profile });
    const profile = await requireBillingProfile(academy.id);
    const plan = getBillingPlan(String(req.body?.plan_code || ''));
    if (!plan) return res.status(400).json({ error: 'Selecciona un plan válido.' });

    const billingCycle = req.body?.billing_cycle === 'annual' ? 'annual' : 'monthly';
    const promotionCode = req.body?.promotion_code === 'founder' ? 'founder' : null;
    const guardians = req.body?.guardian_license === true;
    const idempotencyKey = requestIdempotencyKey(req);

    let quote;
    try { quote = getBillingQuote({ planCode: plan.code, billingCycle, promotionCode, guardians }); }
    catch (error) { return res.status(400).json({ error: error.message, code: error.code || 'INVALID_BILLING_OFFER' }); }

    if (promotionCode === 'founder' && academy.founder_number && academy.promotion_ends_at && academy.promotion_ends_at < today()) {
      return res.status(409).json({ error: 'Tu período de Precio Fundador de 12 meses ya terminó.', code: 'FOUNDER_EXPIRED' });
    }

    const profileSnapshot = billingSnapshot(profile);
    const fingerprint = idempotencyFingerprint({
      kind: 'initial',
      academy_id: academy.id,
      plan_code: plan.code,
      billing_cycle: quote.billingCycle,
      promotion_code: quote.promotionCode,
      guardian_license: guardians,
      charged_net_clp: quote.chargedNetClp,
      charged_gross_clp: quote.chargedGrossClp,
      billing_document_type: profile.documento_tipo,
      billing_snapshot: profileSnapshot,
    });

    charge = await findIdempotentPlatformCharge(academy.id, idempotencyKey);
    if (charge) assertCheckoutFingerprint(charge, fingerprint);

    if (!charge) {
      const openCharge = await findOpenPlatformCharge(academy.id, 'initial');
      if (openCharge?.idempotency_fingerprint === fingerprint) {
        charge = openCharge;
      } else {
        await invalidatePreviousInitialCheckouts(academy.id, operationStartedAt);
      }
    }

    const label = promotionCode === 'founder'
      ? `${plan.name} · Precio Fundador`
      : billingCycle === 'annual'
        ? `${plan.name} · Anual (12 meses pagando 10)`
        : `${plan.name} · Mensual`;

    if (!charge) {
      const payload = {
        academia_id: academy.id,
        concepto: `Suscripción Lestra Deportivo · ${label}${guardians ? ' + Apoderados PRO' : ''}`,
        subtotal_clp: calculateGrossClp({ priceClp: quote.baseChargedNetClp }),
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
        billing_snapshot: profileSnapshot,
        notas: `Checkout Pro Mercado Pago. Documento solicitado: ${profile.documento_tipo}. Neto total: $${quote.chargedNetClp.toLocaleString('es-CL')} CLP. Total con IVA esperado: $${quote.chargedGrossClp.toLocaleString('es-CL')} CLP.`,
        created_by: req.user.id,
        idempotency_key: idempotencyKey,
        idempotency_fingerprint: fingerprint,
      };
      const { data: created, error: chargeError } = await supabase.from('plataforma_cobros').insert(payload).select('*').single();

      if (chargeError) {
        if (chargeError.code !== '23505') throw chargeError;
        const raced = (await findIdempotentPlatformCharge(academy.id, idempotencyKey))
          || (await findOpenPlatformCharge(academy.id, 'initial'));
        if (!raced || raced.idempotency_fingerprint !== fingerprint) {
          throw Object.assign(
            new Error('Existe otro checkout de plan en preparación. Termínalo o vuelve a intentar el cambio.'),
            { status: 409, code: 'CHECKOUT_IN_PROGRESS' },
          );
        }
        charge = raced;
      } else {
        charge = created;
        ownsCharge = true;
      }
    }

    assertCheckoutFingerprint(charge, fingerprint);
    founderSlot = Number(charge.founder_slot || 0) || null;
    if (promotionCode === 'founder' && !founderSlot) founderSlot = await reserveFounder(charge);

    const amount = Number(charge.total_clp || quote.chargedGrossClp);
    if (charge.estado === 'pagado' && charge.checkout_url) {
      return res.json({
        success: true,
        idempotent: true,
        data: {
          chargeId: charge.id,
          orderId: null,
          checkoutUrl: charge.checkout_url,
          amountClp: amount,
          netAmountClp: quote.chargedNetClp,
          planName: plan.name,
          guardianLicense: guardians,
          billingCycle: quote.billingCycle,
          promotionCode: quote.promotionCode,
          founderSlot,
          discountClp: quote.discountGrossClp,
          documentType: profile.documento_tipo,
          manualVerification: false,
          alreadyPaid: true,
        },
      });
    }

    const order = await createGatewayOrder({ academyId: academy.id, charge, title: charge.concepto, amountClp: amount, userId: req.user.id });
    const { error: chargeUpdateError } = await supabase.from('plataforma_cobros').update({
      checkout_url: order.checkout_url,
      referencia: order.external_reference,
      updated_at: new Date().toISOString(),
    }).eq('id', charge.id);
    if (chargeUpdateError) throw chargeUpdateError;

    return res.status(ownsCharge ? 201 : 200).json({
      success: true,
      idempotent: !ownsCharge,
      data: {
        chargeId: charge.id,
        orderId: order.id,
        checkoutUrl: order.checkout_url,
        amountClp: amount,
        netAmountClp: quote.chargedNetClp,
        planName: plan.name,
        guardianLicense: guardians,
        billingCycle: quote.billingCycle,
        promotionCode: quote.promotionCode,
        founderSlot,
        discountClp: quote.discountGrossClp,
        documentType: profile.documento_tipo,
        manualVerification: false,
      },
    });
  } catch (error) {
    if (ownsCharge && charge?.id) {
      if (founderSlot) {
        await supabase.from('syncademia_founder_slots').update({
          academia_id: null, charge_id: null, reserved_until: null, updated_at: new Date().toISOString(),
        }).eq('slot_no', founderSlot).eq('charge_id', charge.id).is('activated_at', null);
      }
      if (!charge.checkout_url) await supabase.from('plataforma_cobros').delete().eq('id', charge.id).eq('estado', 'pendiente');
    }
    console.error('Error preparando suscripción Checkout Pro:', error?.message || error);
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible preparar el pago.', code: error?.code || undefined });
  }
});

router.post('/renewal/checkout', async (req, res) => {
  try {
    const academy = await getAcademyContract(req.user.academia_id);
    if (!academy.contract_locked_at) return res.status(409).json({ error: 'No existe un contrato activo para renovar.', code: 'CONTRACT_NOT_LOCKED' });
    const profile = await requireBillingProfile(academy.id);
    const charge = await ensureRenewalChargeForAcademy(academy);
    if (!charge) return res.status(409).json({ error: `Tu próxima renovación es el ${academy.next_billing_date || 'próximo ciclo'}. El pago se habilita 7 días antes.`, code: 'RENEWAL_NOT_DUE' });
    if (!['pendiente', 'vencido'].includes(charge.estado)) return res.status(409).json({ error: 'La renovación ya no está disponible.' });
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

router.post('/guardian-addon', async (req, res) => {
  let charge = null;
  let ownsCharge = false;
  const operationStartedAt = new Date().toISOString();

  try {
    const academyContract = await getAcademyContract(req.user.academia_id);
    if (academyContract.contract_locked_at) {
      return res.status(409).json({ error: 'Los cambios de complementos de un contrato activo deben ser autorizados por Lestra.', code: 'CONTRACT_CHANGE_APPROVAL_REQUIRED' });
    }

    const profile = await requireBillingProfile(req.user.academia_id);
    const { data: academy, error: academyError } = await supabase.from('academias')
      .select('id,plan,plan_codigo,subscription_status,licencia_apoderados,guardian_license_ends_at')
      .eq('id', req.user.academia_id)
      .single();
    if (academyError) throw academyError;
    if (isTrialPlan(academy)) return res.status(409).json({ error: 'Apoderados PRO ya está incluido durante tu prueba Full.', code: 'GUARDIAN_INCLUDED_IN_TRIAL' });
    if (academy.subscription_status !== 'active') return res.status(409).json({ error: 'Activa primero un plan de Lestra Deportivo.', code: 'BASE_PLAN_REQUIRED' });

    const cycle = req.body?.billing_cycle === 'annual' ? 'annual' : 'monthly';
    const quote = guardianAddonQuote(cycle);
    const idempotencyKey = requestIdempotencyKey(req);
    const profileSnapshot = billingSnapshot(profile);
    const fingerprint = idempotencyFingerprint({
      kind: 'addon',
      academy_id: academy.id,
      billing_cycle: quote.billingCycle,
      charged_net_clp: quote.chargedNetClp,
      charged_gross_clp: quote.chargedGrossClp,
      billing_document_type: profile.documento_tipo,
      billing_snapshot: profileSnapshot,
    });

    charge = await findIdempotentPlatformCharge(academy.id, idempotencyKey);
    if (charge) assertCheckoutFingerprint(charge, fingerprint);

    if (!charge) {
      const openCharge = await findOpenPlatformCharge(academy.id, 'addon');
      if (openCharge?.idempotency_fingerprint === fingerprint) {
        charge = openCharge;
      } else if (openCharge && new Date(openCharge.created_at).toISOString() < operationStartedAt) {
        await cancelOpenAddonCheckout(academy.id, openCharge.id);
      }
    }

    if (!charge) {
      const payload = {
        academia_id: academy.id,
        concepto: `Complemento Lestra Deportivo · Apoderados PRO · ${cycle === 'annual' ? 'Anual (12 meses pagando 10)' : 'Mensual'}`,
        subtotal_clp: 0,
        addon_clp: quote.chargedGrossClp,
        target_plan_code: null,
        target_guardian_license: true,
        billing_cycle: quote.billingCycle,
        billing_period_months: quote.billingPeriodMonths,
        promotion_code: null,
        discount_clp: quote.discountGrossClp,
        fecha_vencimiento: addDays(3),
        charge_kind: 'addon',
        billing_document_type: profile.documento_tipo,
        billing_snapshot: profileSnapshot,
        notas: `Checkout Pro Mercado Pago. Documento solicitado: ${profile.documento_tipo}. Neto: $${quote.chargedNetClp.toLocaleString('es-CL')} CLP. Total con IVA: $${quote.chargedGrossClp.toLocaleString('es-CL')} CLP.`,
        created_by: req.user.id,
        idempotency_key: idempotencyKey,
        idempotency_fingerprint: fingerprint,
      };
      const { data: created, error } = await supabase.from('plataforma_cobros').insert(payload).select('*').single();

      if (error) {
        if (error.code !== '23505') throw error;
        const raced = (await findIdempotentPlatformCharge(academy.id, idempotencyKey))
          || (await findOpenPlatformCharge(academy.id, 'addon'));
        if (!raced || raced.idempotency_fingerprint !== fingerprint) {
          throw Object.assign(
            new Error('Existe otro checkout de Apoderados PRO en preparación.'),
            { status: 409, code: 'CHECKOUT_IN_PROGRESS' },
          );
        }
        charge = raced;
      } else {
        charge = created;
        ownsCharge = true;
      }
    }

    assertCheckoutFingerprint(charge, fingerprint);
    const amount = Number(charge.total_clp || quote.chargedGrossClp);
    const order = await createGatewayOrder({ academyId: academy.id, charge, title: charge.concepto, amountClp: amount, userId: req.user.id });
    const { error: chargeUpdateError } = await supabase.from('plataforma_cobros').update({
      checkout_url: order.checkout_url,
      referencia: order.external_reference,
      updated_at: new Date().toISOString(),
    }).eq('id', charge.id);
    if (chargeUpdateError) throw chargeUpdateError;

    return res.status(ownsCharge ? 201 : 200).json({
      success: true,
      idempotent: !ownsCharge,
      data: {
        chargeId: charge.id,
        orderId: order.id,
        checkoutUrl: order.checkout_url,
        amountClp: amount,
        netAmountClp: quote.chargedNetClp,
        manualVerification: false,
      },
    });
  } catch (error) {
    if (ownsCharge && charge?.id && !charge.checkout_url) {
      await supabase.from('plataforma_cobros').delete().eq('id', charge.id).eq('estado', 'pendiente');
    }
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible preparar Apoderados PRO.', code: error?.code });
  }
});


module.exports = router;