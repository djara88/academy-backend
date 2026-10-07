const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { loadPortalToken, authorizedPlayersForToken } = require('../services/collectionPortal');
const { recalculateFinancialStatus } = require('../services/monthlyBilling');
const { activateChargePlan } = require('../services/subscriptionBilling');
const { lockContractFromCharge, ensureSubscriptionExpense } = require('../services/subscriptionContract');
const {
  CHECKOUT_VALIDITY_MS,
  PLATFORM_ACCESS_TOKEN,
  OAUTH_REDIRECT_URI,
  PUBLIC_WEB_URL,
  gatewayCapabilities,
  createPreference,
  getPayment,
  getAcademyConnection,
  storeAcademyCredentials,
  exchangeAuthorizationCode,
  buildAuthorizationUrl,
  verifyState,
  validateWebhookSignature,
} = require('../services/mercadoPagoGateway');

const router = express.Router();
const safe = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const money = (value) => Math.round(Number(value || 0));
const cryptoRandom = () => require('crypto').randomUUID();

const checkoutFingerprint = ({ scope, academyId, platformChargeId = null, amountClp, items = [] }) => {
  const normalizedItems = [...items]
    .map((item) => ({
      cobro_id: String(item.cobro_id || ''),
      cuota_id: String(item.cuota_id || ''),
      amount_clp: money(item.amount_clp),
    }))
    .sort((a, b) => `${a.cobro_id}:${a.cuota_id}`.localeCompare(`${b.cobro_id}:${b.cuota_id}`));
  return require('crypto').createHash('sha256').update(JSON.stringify({
    scope,
    academyId: String(academyId || ''),
    platformChargeId: String(platformChargeId || ''),
    amountClp: money(amountClp),
    items: normalizedItems,
  })).digest('hex');
};

const cleanupStaleOrders = async () => {
  const cutoff = new Date(Date.now() - CHECKOUT_VALIDITY_MS).toISOString();
  const { error } = await supabase.from('payment_gateway_orders').update({
    status: 'cancelled',
    updated_at: new Date().toISOString(),
  }).eq('status', 'created').is('payment_id', null).lt('created_at', cutoff);
  if (error) throw error;
};

const cleanupPaymentOrders = () => {
  const run = () => void cleanupStaleOrders().catch((error) => console.error('Limpieza de órdenes Mercado Pago falló:', error?.message || error));
  const warmup = setTimeout(run, 20_000);
  warmup.unref?.();
  const timer = setInterval(run, 60 * 60 * 1000);
  timer.unref?.();
};
cleanupPaymentOrders();

const createOrder = async ({ scope, academyId, platformChargeId = null, amountClp, title, createdBy = null, items = [], payerEmail = null, accessToken }) => {
  await cleanupStaleOrders();
  const fingerprint = checkoutFingerprint({ scope, academyId, platformChargeId, amountClp, items });
  const cutoff = new Date(Date.now() - CHECKOUT_VALIDITY_MS).toISOString();
  const { data: activeOrders, error: activeError } = await supabase.from('payment_gateway_orders')
    .select('*')
    .eq('scope', scope)
    .eq('academia_id', academyId)
    .in('status', ['created', 'pending'])
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(20);
  if (activeError) throw activeError;
  const reusable = (activeOrders || []).find((row) => row.checkout_url && row.metadata?.checkout_fingerprint === fingerprint);
  if (reusable) return reusable;

  const idempotencyKey = `checkout:${fingerprint}`;
  const externalReference = `lestra:${scope}:${cryptoRandom()}`;
  const { data: order, error } = await supabase.from('payment_gateway_orders').insert({
    scope,
    academia_id: academyId,
    plataforma_cobro_id: platformChargeId,
    external_reference: externalReference,
    amount_expected: amountClp,
    status: 'created',
    created_by: createdBy,
    idempotency_key: idempotencyKey,
    metadata: { title, checkout_fingerprint: fingerprint },
  }).select('*').single();
  if (error) {
    if (error.code === '23505') {
      const { data: duplicate, error: duplicateError } = await supabase.from('payment_gateway_orders')
        .select('*')
        .eq('academia_id', academyId)
        .eq('idempotency_key', idempotencyKey)
        .in('status', ['created', 'pending'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (duplicateError) throw duplicateError;
      if (duplicate?.checkout_url) return duplicate;
      if (duplicate) throw Object.assign(new Error('El checkout ya se está preparando. Reintenta en unos segundos.'), { status: 409, code: 'CHECKOUT_IN_PROGRESS' });
    }
    throw error;
  }

  if (items.length) {
    const { error: itemError } = await supabase.from('payment_gateway_order_items').insert(items.map((item) => ({
      order_id: order.id,
      cobro_id: item.cobro_id,
      cuota_id: item.cuota_id || null,
      amount_clp: item.amount_clp,
      concepto: item.concepto,
    })));
    if (itemError) {
      await supabase.from('payment_gateway_orders').delete().eq('id', order.id);
      throw itemError;
    }
  }

  try {
    const preference = await createPreference({
      accessToken,
      externalReference,
      title,
      amountClp,
      payerEmail,
      orderId: order.id,
      metadata: { scope, academy_id: academyId, plataforma_cobro_id: platformChargeId || undefined },
    });
    const checkoutUrl = preference?.init_point || preference?.sandbox_init_point || null;
    if (!preference?.id || !checkoutUrl) throw new Error('Mercado Pago no devolvió una URL de checkout.');
    const { data: updated, error: updateError } = await supabase.from('payment_gateway_orders').update({
      preference_id: String(preference.id),
      checkout_url: checkoutUrl,
      updated_at: new Date().toISOString(),
    }).eq('id', order.id).select('*').single();
    if (updateError) throw updateError;
    return updated;
  } catch (checkoutError) {
    await supabase.from('payment_gateway_orders').update({
      status: 'error',
      metadata: { title, checkout_fingerprint: fingerprint, error: String(checkoutError.message || checkoutError).slice(0, 500) },
      updated_at: new Date().toISOString(),
    }).eq('id', order.id);
    throw checkoutError;
  }
};

const loadAcademyCheckoutItems = async ({ tokenRow, selections }) => {
  const players = await authorizedPlayersForToken(tokenRow);
  const playerIds = new Set(players.map((row) => String(row.id)));
  const raw = Array.isArray(selections) ? selections.slice(0, 20) : [];
  if (!raw.length) throw Object.assign(new Error('Selecciona al menos un concepto para pagar.'), { status: 400 });
  const chargeIds = [...new Set(raw.map((row) => safe(row?.cobro_id, 80)).filter(Boolean))];
  const { data: charges, error: chargeError } = await supabase.from('cobros')
    .select('id,jugador_id,concepto,monto,monto_pagado,estado')
    .eq('academia_id', tokenRow.academia_id).in('id', chargeIds).neq('estado', 'Anulado');
  if (chargeError) throw chargeError;
  const byCharge = new Map((charges || []).map((row) => [String(row.id), row]));
  const quotaIds = [...new Set(raw.map((row) => safe(row?.cuota_id, 80)).filter(Boolean))];
  let quotas = [];
  if (quotaIds.length) {
    const result = await supabase.from('cobro_cuotas').select('id,cobro_id,numero,total_cuotas,monto,monto_pagado,estado').eq('academia_id', tokenRow.academia_id).in('id', quotaIds).neq('estado', 'Anulada');
    if (result.error) throw result.error;
    quotas = result.data || [];
  }
  const byQuota = new Map(quotas.map((row) => [String(row.id), row]));
  const { data: pendingReports, error: pendingError } = await supabase.from('pagos_informados')
    .select('cobro_id,cuota_id,monto').eq('academia_id', tokenRow.academia_id).in('cobro_id', chargeIds).eq('estado', 'Pendiente');
  if (pendingError) throw pendingError;
  const pendingByTarget = new Map();
  for (const row of pendingReports || []) {
    const key = `${row.cobro_id}:${row.cuota_id || ''}`;
    pendingByTarget.set(key, (pendingByTarget.get(key) || 0) + Number(row.monto || 0));
  }

  const items = [];
  const seen = new Set();
  for (const selected of raw) {
    const chargeId = safe(selected?.cobro_id, 80);
    const quotaId = safe(selected?.cuota_id, 80) || null;
    const uniqueKey = `${chargeId}:${quotaId || ''}`;
    if (seen.has(uniqueKey)) continue;
    seen.add(uniqueKey);
    const charge = byCharge.get(chargeId);
    if (!charge || !playerIds.has(String(charge.jugador_id)) || ['Pagado', 'Anulado'].includes(charge.estado)) throw Object.assign(new Error('Uno de los cobros seleccionados ya no está disponible.'), { status: 409 });
    let amount = Math.max(Number(charge.monto || 0) - Number(charge.monto_pagado || 0), 0);
    let concept = charge.concepto;
    if (quotaId) {
      const quota = byQuota.get(quotaId);
      if (!quota || String(quota.cobro_id) !== chargeId || quota.estado === 'Pagada') throw Object.assign(new Error('Una de las cuotas seleccionadas ya no está disponible.'), { status: 409 });
      amount = Math.max(Number(quota.monto || 0) - Number(quota.monto_pagado || 0), 0);
      concept = `${charge.concepto} · Cuota ${quota.numero}/${quota.total_cuotas}`;
    }
    if ((pendingByTarget.get(uniqueKey) || 0) > 0) throw Object.assign(new Error(`Existe una transferencia informada pendiente de validación para “${concept}”. Revísala antes de pagar en línea.`), { status: 409 });
    amount = Math.round(amount);
    if (amount <= 0) continue;
    items.push({ cobro_id: charge.id, cuota_id: quotaId, amount_clp: amount, concepto: concept });
  }
  if (!items.length) throw Object.assign(new Error('Los conceptos seleccionados ya no tienen saldo pendiente.'), { status: 409 });
  return { items, players };
};

router.get('/status', authMiddleware, requireDirector, async (req, res) => {
  try {
    const connection = await getAcademyConnection(req.user.academia_id);
    return res.json({ success: true, data: {
      capabilities: gatewayCapabilities(),
      academy: connection ? { connected: true, status: connection.status, mp_user_id: connection.mp_user_id, connected_at: connection.connected_at, token_expires_at: connection.token_expires_at } : { connected: false, status: 'desconectado' },
    } });
  } catch (error) {
    return res.status(500).json({ error: 'No fue posible consultar Mercado Pago.' });
  }
});

router.post('/oauth/connect', authMiddleware, requireDirector, async (req, res) => {
  try {
    return res.json({ success: true, url: buildAuthorizationUrl({ academyId: req.user.academia_id, userId: req.user.id }) });
  } catch (error) {
    return res.status(503).json({ error: error.message || 'OAuth de Mercado Pago no está disponible.' });
  }
});

router.get('/oauth/callback', async (req, res) => {
  const webUrl = PUBLIC_WEB_URL();
  try {
    const state = verifyState(req.query?.state);
    const code = safe(req.query?.code, 500);
    if (!state || !code) return res.redirect(`${webUrl}/configuracion/finanzas?mp=error&reason=oauth`);
    const oauth = await exchangeAuthorizationCode({ code, redirectUri: OAUTH_REDIRECT_URI() });
    await storeAcademyCredentials({ academyId: state.academyId, oauth });
    await supabase.from('configuracion_financiera').update({ acepta_pago_online: true, link_pago_online: '', updated_at: new Date().toISOString() }).eq('academia_id', state.academyId);
    return res.redirect(`${webUrl}/configuracion/finanzas?mp=connected`);
  } catch (error) {
    console.error('Error conectando Mercado Pago:', error?.message || error);
    return res.redirect(`${webUrl}/configuracion/finanzas?mp=error`);
  }
});

router.post('/disconnect', authMiddleware, requireDirector, async (req, res) => {
  try {
    const { error } = await supabase.from('mercadopago_conexiones').update({ status: 'desconectado', updated_at: new Date().toISOString() }).eq('academia_id', req.user.academia_id);
    if (error) throw error;
    await supabase.from('configuracion_financiera').update({ acepta_pago_online: false, link_pago_online: '', updated_at: new Date().toISOString() }).eq('academia_id', req.user.academia_id);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'No fue posible desconectar Mercado Pago.' });
  }
});

router.post('/academy/checkout/:token', async (req, res) => {
  try {
    const tokenRow = await loadPortalToken(req.params.token);
    if (!tokenRow) return res.status(401).json({ error: 'El enlace de pago venció o ya no es válido.' });
    const { data: config, error: configError } = await supabase.from('configuracion_financiera').select('acepta_pago_online').eq('academia_id', tokenRow.academia_id).maybeSingle();
    if (configError) throw configError;
    if (config?.acepta_pago_online !== true) return res.status(409).json({ error: 'La academia no tiene pagos en línea habilitados.' });
    const connection = await getAcademyConnection(tokenRow.academia_id, { withAccessToken: true });
    if (!connection?.accessToken) return res.status(409).json({ error: 'La academia todavía no ha conectado su cuenta Mercado Pago.' });
    const { items, players } = await loadAcademyCheckoutItems({ tokenRow, selections: req.body?.items });
    const amount = items.reduce((sum, item) => sum + item.amount_clp, 0);
    let payerEmail = null;
    if (tokenRow.tutor_id) {
      const { data: tutor } = await supabase.from('tutores').select('email').eq('id', tokenRow.tutor_id).eq('academia_id', tokenRow.academia_id).maybeSingle();
      payerEmail = tutor?.email || null;
    }
    const title = items.length === 1 ? items[0].concepto : `Estado de cuenta · ${players.map((row) => row.nombre).join(', ')}`;
    const order = await createOrder({ scope: 'academia', academyId: tokenRow.academia_id, amountClp: amount, title, items, payerEmail, accessToken: connection.accessToken });
    return res.status(201).json({ success: true, data: { orderId: order.id, amountClp: order.amount_expected, checkoutUrl: order.checkout_url } });
  } catch (error) {
    console.error('Error creando checkout de academia:', error?.message || error);
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible preparar el pago en línea.' });
  }
});

router.post('/platform/checkout', authMiddleware, requireDirector, async (req, res) => {
  try {
    const chargeId = safe(req.body?.charge_id, 80);
    const { data: charge, error } = await supabase.from('plataforma_cobros').select('*').eq('id', chargeId).eq('academia_id', req.user.academia_id).maybeSingle();
    if (error) throw error;
    if (!charge || !['pendiente', 'vencido'].includes(charge.estado)) return res.status(409).json({ error: 'El cobro de Lestra no está disponible.' });
    const { data: academy, error: academyError } = await supabase.from('academias').select('contract_locked_at,contract_source_charge_id').eq('id', req.user.academia_id).single();
    if (academyError) throw academyError;
    if (academy.contract_locked_at && ['manual', 'initial'].includes(String(charge.charge_kind || 'manual')) && charge.target_plan_code) {
      return res.status(409).json({ error: 'Ese checkout ya no pertenece al contrato vigente. Utiliza la renovación o solicita un cambio a Lestra.', code: 'STALE_CONTRACT_CHECKOUT' });
    }
    const token = PLATFORM_ACCESS_TOKEN();
    if (!token) return res.status(503).json({ error: 'Lestra todavía no tiene Checkout Pro configurado.' });
    const amount = money(charge.total_clp);
    const order = await createOrder({ scope: 'plataforma', academyId: charge.academia_id, platformChargeId: charge.id, amountClp: amount, title: charge.concepto, createdBy: req.user.id, accessToken: token });
    await supabase.from('plataforma_cobros').update({ checkout_url: order.checkout_url, referencia: order.external_reference, updated_at: new Date().toISOString() }).eq('id', charge.id);
    return res.status(201).json({ success: true, data: { orderId: order.id, amountClp: order.amount_expected, checkoutUrl: order.checkout_url } });
  } catch (error) {
    console.error('Error creando checkout de Lestra:', error?.message || error);
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible preparar el pago de Lestra.' });
  }
});

router.get('/order/:id', async (req, res) => {
  try {
    await cleanupStaleOrders();
    const { data, error } = await supabase.from('payment_gateway_orders')
      .select('amount_expected,amount_approved,status,approved_at,created_at')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Orden no encontrada.' });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ error: 'No fue posible consultar el pago.' });
  }
});

router.post('/webhook', async (req, res) => {
  const dataId = req.query?.['data.id'] || req.body?.data?.id;
  const action = safe(req.body?.action, 120).toLowerCase();
  const type = safe(req.body?.type, 80).toLowerCase();
  const isPaymentEnvelope = Boolean(dataId) && (type === 'payment' || action.startsWith('payment.') || (!type && !action));
  const xSignature = req.headers['x-signature'];
  const xRequestId = req.headers['x-request-id'];
  const signatureValid = validateWebhookSignature({ xSignature, xRequestId, dataId });
  const eventKey = String(req.body?.id || `${type || 'payment'}:${dataId || cryptoRandom()}:${action}`).slice(0, 240);

  if (!signatureValid) {
    if (isPaymentEnvelope) {
      await supabase.from('payment_gateway_events').upsert({
        provider: 'mercadopago',
        event_key: eventKey,
        event_type: req.body?.action || req.body?.type || null,
        payment_id: dataId ? String(dataId) : null,
        signature_valid: false,
        payload: req.body || {},
      }, { onConflict: 'provider,event_key', ignoreDuplicates: true });
    }
    return res.sendStatus(401);
  }

  if (!isPaymentEnvelope) return res.sendStatus(200);

  try {
    const inserted = await supabase.from('payment_gateway_events').upsert({ provider: 'mercadopago', event_key: eventKey, event_type: req.body?.action || req.body?.type || null, payment_id: dataId ? String(dataId) : null, signature_valid: true, payload: req.body || {} }, { onConflict: 'provider,event_key', ignoreDuplicates: true }).select('id,processed_at').maybeSingle();
    if (inserted.error) throw inserted.error;
    if (inserted.data?.processed_at) return res.sendStatus(200);

    let accessToken = null;
    const merchantUserId = Number(req.body?.user_id || 0) || null;
    if (merchantUserId) {
      const { data: connection, error: connectionError } = await supabase.from('mercadopago_conexiones').select('academia_id').eq('mp_user_id', merchantUserId).eq('status', 'conectado').maybeSingle();
      if (connectionError) throw connectionError;
      if (connection) accessToken = (await getAcademyConnection(connection.academia_id, { withAccessToken: true }))?.accessToken || null;
    }
    accessToken = accessToken || PLATFORM_ACCESS_TOKEN();
    if (!accessToken) throw new Error('No existe token para consultar el pago notificado.');

    const payment = await getPayment({ accessToken, paymentId: dataId });
    const externalReference = safe(payment?.external_reference, 300);
    if (!externalReference.startsWith('lestra:')) {
      if (inserted.data?.id) await supabase.from('payment_gateway_events').update({
        processed_at: new Date().toISOString(),
        external_reference: externalReference || null,
        processing_error: null,
      }).eq('id', inserted.data.id);
      return res.sendStatus(200);
    }

    const { data: order, error: orderError } = await supabase.from('payment_gateway_orders').select('*').eq('external_reference', externalReference).maybeSingle();
    if (orderError) throw orderError;
    if (!order) {
      if (inserted.data?.id) await supabase.from('payment_gateway_events').update({ processed_at: new Date().toISOString(), external_reference: externalReference, processing_error: 'Orden Lestra no encontrada' }).eq('id', inserted.data.id);
      return res.sendStatus(200);
    }

    const status = String(payment.status || 'pending').toLowerCase();
    const amountApproved = money(payment.transaction_amount);
    const commonUpdate = { payment_id: String(payment.id), merchant_user_id: Number(payment.collector_id || merchantUserId || 0) || null, amount_approved: amountApproved || null, payer_email: payment.payer?.email || null, updated_at: new Date().toISOString() };
    if (status !== 'approved') {
      const mapped = ['rejected', 'cancelled', 'refunded'].includes(status) ? status : 'pending';
      await supabase.from('payment_gateway_orders').update({ ...commonUpdate, status: mapped }).eq('id', order.id);
      if (inserted.data?.id) await supabase.from('payment_gateway_events').update({ processed_at: new Date().toISOString(), external_reference: externalReference }).eq('id', inserted.data.id);
      return res.sendStatus(200);
    }

    if (String(payment.currency_id || '') !== 'CLP' || amountApproved !== Number(order.amount_expected)) throw new Error(`Pago aprobado no coincide con la orden: esperado ${order.amount_expected} CLP, recibido ${amountApproved} ${payment.currency_id || ''}`);

    if (order.scope === 'academia') {
      const { data: items, error: itemError } = await supabase.from('payment_gateway_order_items').select('*').eq('order_id', order.id).order('created_at');
      if (itemError) throw itemError;
      for (const item of items || []) {
        const result = await supabase.rpc('registrar_pago_cobro_dirigido', {
          p_academia_id: order.academia_id,
          p_cobro_id: item.cobro_id,
          p_cuota_id: item.cuota_id,
          p_monto: item.amount_clp,
          p_metodo_pago: 'Mercado Pago',
          p_observaciones: `Pago confirmado automáticamente por Mercado Pago · operación ${payment.id}`,
          p_idempotency_key: `mp:${payment.id}:${item.id}`,
          p_usuario_id: null,
        });
        if (result.error) throw result.error;
      }
      await recalculateFinancialStatus(order.academia_id);
    } else if (order.scope === 'plataforma') {
      const { data: charge, error: chargeError } = await supabase.from('plataforma_cobros').select('*').eq('id', order.plataforma_cobro_id).maybeSingle();
      if (chargeError || !charge) throw chargeError || new Error('Cobro de plataforma no encontrado.');

      if (charge.estado === 'anulado') {
        await supabase.from('payment_gateway_orders').update({ ...commonUpdate, status: 'approved', approved_at: payment.date_approved || new Date().toISOString() }).eq('id', order.id);
        if (inserted.data?.id) await supabase.from('payment_gateway_events').update({
          processed_at: new Date().toISOString(),
          external_reference: externalReference,
          processing_error: 'Pago aprobado para un cobro anulado. No se aplicó al contrato; requiere revisión administrativa.',
        }).eq('id', inserted.data.id);
        return res.sendStatus(200);
      }

      if (!['pendiente', 'vencido', 'pagado'].includes(charge.estado)) throw new Error(`Estado de cobro Lestra no procesable: ${charge.estado}`);
      if (charge.estado !== 'pagado') {
        const paid = await supabase.rpc('marcar_cobro_plataforma_pagado', { p_cobro_id: charge.id, p_created_by: null, p_metodo_pago: 'Mercado Pago', p_referencia: String(payment.id) });
        if (paid.error) throw paid.error;
        await activateChargePlan({ ...charge, pagado_at: payment.date_approved || new Date().toISOString() });
      }
      await lockContractFromCharge(charge);
      await ensureSubscriptionExpense({
        charge,
        paymentId: String(payment.id),
        paidAt: payment.date_approved || new Date().toISOString(),
        method: 'Mercado Pago',
      });
    }

    await supabase.from('payment_gateway_orders').update({ ...commonUpdate, status: 'approved', approved_at: payment.date_approved || new Date().toISOString() }).eq('id', order.id);
    if (inserted.data?.id) await supabase.from('payment_gateway_events').update({ processed_at: new Date().toISOString(), external_reference: externalReference, processing_error: null }).eq('id', inserted.data.id);
    return res.sendStatus(200);
  } catch (error) {
    console.error('Webhook Mercado Pago no procesado:', error?.message || error);
    await supabase.from('payment_gateway_events').update({ processing_error: String(error?.message || error).slice(0, 1000) }).eq('provider', 'mercadopago').eq('event_key', eventKey);
    return res.sendStatus(500);
  }
});

module.exports = router;