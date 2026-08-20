const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireSuperadmin } = require('../middleware/authorization');
const { requireSuperadminMfa } = require('../middleware/requireMfa');
const { getSubscriptionState } = require('../services/subscriptionAccess');
const { activateChargePlan } = require('../services/subscriptionBilling');
const { getSystemMonitorSnapshot } = require('../services/systemMonitor');
const {
  getAcademyContract,
  ensureRenewalChargeForAcademy,
  lockContractFromCharge,
  ensureSubscriptionExpense,
} = require('../services/subscriptionContract');

const router = express.Router();
router.use(authMiddleware, requireSuperadmin, requireSuperadminMfa);

const monthBounds = () => {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  return { start, end };
};
const number = (value) => Number(value || 0);
const clean = (value, max = 1000) => String(value ?? '').trim().replace(/[\r\n|]+/g, ' ').slice(0, max);
const mercadoPagoLink = () => String(process.env.MERCADO_PAGO_PAYMENT_LINK || 'https://link.mercadopago.cl/smproweb').trim();
const mercadoPagoConfigured = () => /^https:\/\/link\.mercadopago\.cl\/[A-Za-z0-9._-]+$/i.test(mercadoPagoLink());

const ensureFounderReservationBeforePayment = async (charge) => {
  if (charge?.promotion_code !== 'founder') return charge;

  const { data: academy, error: academyError } = await supabase.from('academias')
    .select('founder_number,promotion_code,promotion_ends_at').eq('id', charge.academia_id).single();
  if (academyError) throw academyError;
  const existingFounderActive = academy?.founder_number && academy?.promotion_code === 'founder'
    && academy?.promotion_ends_at && academy.promotion_ends_at >= new Date().toISOString().slice(0, 10);
  if (charge.charge_kind === 'renewal' && existingFounderActive) return charge;

  const { data: slot, error: slotError } = await supabase.rpc('reservar_syncademia_founder_slot', {
    p_academia_id: charge.academia_id,
    p_charge_id: charge.id,
  });
  if (slotError) throw slotError;

  const founderSlot = Number(slot || 0) || null;
  if (!founderSlot) {
    const error = new Error('No quedan cupos de Precio Fundador disponibles para validar este pago. No se registró el abono; genera una nueva orden mensual o anual.');
    error.status = 409;
    error.code = 'FOUNDER_SOLD_OUT_BEFORE_PAYMENT';
    throw error;
  }

  if (founderSlot !== Number(charge.founder_slot || 0)) {
    const { error: updateError } = await supabase.from('plataforma_cobros')
      .update({ founder_slot: founderSlot, updated_at: new Date().toISOString() })
      .eq('id', charge.id)
      .eq('academia_id', charge.academia_id)
      .neq('estado', 'pagado');
    if (updateError) throw updateError;
    charge.founder_slot = founderSlot;
  }

  return charge;
};

const cancelRenewalForEffectiveDate = async (academyId, effectiveFrom) => {
  if (!effectiveFrom) return;
  const { data: charges, error } = await supabase.from('plataforma_cobros').select('id')
    .eq('academia_id', academyId).eq('charge_kind', 'renewal').eq('periodo_inicio', effectiveFrom).in('estado', ['pendiente', 'vencido']);
  if (error) throw error;
  const ids = (charges || []).map((row) => row.id);
  if (!ids.length) return;
  const now = new Date().toISOString();
  const { error: chargeError } = await supabase.from('plataforma_cobros').update({ estado: 'anulado', updated_at: now }).in('id', ids);
  if (chargeError) throw chargeError;
  const { error: orderError } = await supabase.from('payment_gateway_orders').update({ status: 'cancelled', updated_at: now })
    .eq('scope', 'plataforma').in('plataforma_cobro_id', ids).in('status', ['created', 'pending']);
  if (orderError) throw orderError;
};

router.get('/monitor', async (_req, res) => {
  try {
    const data = await getSystemMonitorSnapshot();
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error cargando monitor del sistema:', error?.message || 'Error desconocido');
    res.status(500).json({ error: 'No fue posible cargar el monitor del sistema.' });
  }
});

router.get('/activation-funnel', async (req, res) => {
  try {
    const requestedDays = Number(req.query.days || 30);
    const days = Math.min(Math.max(Number.isFinite(requestedDays) ? Math.round(requestedDays) : 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase.rpc('obtener_embudo_activacion_syncademia', { p_since: since });
    if (error) throw error;
    res.json({ success: true, data: { ...(data || {}), windowDays: days } });
  } catch (error) {
    console.error('Error cargando embudo de activación:', error?.message || 'Error desconocido');
    res.status(500).json({ error: 'No fue posible cargar el embudo de activación.' });
  }
});

router.get('/resumen', async (_req, res) => {
  try {
    await supabase.rpc('refrescar_pruebas_vencidas');
    const { start, end } = monthBounds();
    const [academiesResult, chargesResult, movementsResult, changesResult] = await Promise.all([
      supabase.from('academias').select('id,nombre,plan,plan_codigo,estado,created_at,subscription_status,trial_started_at,trial_ends_at,blocked_at,blocked_reason,next_billing_date,plan_price_clp,guardian_price_clp,licencia_apoderados,jugadores_count,max_profesores,contract_locked_at'),
      supabase.from('plataforma_cobros').select('id,academia_id,total_clp,estado,fecha_vencimiento,pagado_at'),
      supabase.from('plataforma_movimientos').select('id,tipo,monto_clp,fecha').gte('fecha', start).lt('fecha', end),
      supabase.from('subscription_change_requests').select('id,status').eq('status', 'pending'),
    ]);
    if (academiesResult.error) throw academiesResult.error;
    if (chargesResult.error) throw chargesResult.error;
    if (movementsResult.error) throw movementsResult.error;
    if (changesResult.error) throw changesResult.error;
    const today = new Date().toISOString().slice(0, 10);
    const academies = (academiesResult.data || []).map((academy) => ({ ...academy, subscription: getSubscriptionState(academy) }));
    const charges = chargesResult.data || [];
    const movements = movementsResult.data || [];
    const active = academies.filter((academy) => academy.subscription_status === 'active' && !academy.subscription.blocked);
    const trials = academies.filter((academy) => academy.subscription_status === 'trialing');
    const alerts = [
      ...trials.filter((academy) => ['critical', 'high', 'medium'].includes(academy.subscription.urgency)).map((academy) => ({
        type: 'trial', severity: academy.subscription.urgency, academyId: academy.id, academyName: academy.nombre,
        message: academy.subscription.remainingDays === 0 ? 'La prueba vence hoy' : `Quedan ${academy.subscription.remainingDays} días de prueba`,
      })),
      ...academies.filter((academy) => academy.subscription.blocked).map((academy) => ({
        type: 'blocked', severity: 'critical', academyId: academy.id, academyName: academy.nombre,
        message: academy.subscription.reason || 'Academia bloqueada',
      })),
      ...charges.filter((charge) => charge.estado === 'pendiente' && charge.fecha_vencimiento < today).map((charge) => ({
        type: 'overdue', severity: 'high', academyId: charge.academia_id,
        academyName: academies.find((academy) => academy.id === charge.academia_id)?.nombre || 'Academia',
        message: `Cobro vencido por $${number(charge.total_clp).toLocaleString('es-CL')}`,
      })),
    ];
    const income = movements.filter((item) => item.tipo === 'ingreso').reduce((sum, item) => sum + number(item.monto_clp), 0);
    const expenses = movements.filter((item) => item.tipo === 'egreso').reduce((sum, item) => sum + number(item.monto_clp), 0);
    const receivable = charges.filter((charge) => ['pendiente', 'vencido'].includes(charge.estado)).reduce((sum, item) => sum + number(item.total_clp), 0);
    const mrrClpNet = active.reduce((sum, academy) => sum + number(academy.plan_price_clp) + number(academy.guardian_price_clp), 0);
    res.json({ success: true, data: {
      kpis: {
        academies: academies.length, active: active.length, trials: trials.length,
        blocked: academies.filter((academy) => academy.subscription.blocked).length,
        mrrClpNet, mrrClpGross: Math.round(mrrClpNet * 1.19),
        income, expenses, net: income - expenses, receivable,
        pendingPlanChanges: (changesResult.data || []).length,
        conversionRate: academies.length ? Math.round((active.length / academies.length) * 100) : 0,
      },
      academies, alerts: alerts.slice(0, 30),
      gateway: { provider: 'Mercado Pago', configured: mercadoPagoConfigured(), manualVerification: true },
    } });
  } catch (error) {
    res.status(500).json({ error: error.message || 'No fue posible cargar el centro ejecutivo.' });
  }
});

router.get('/subscription-change-requests', async (req, res) => {
  try {
    const requested = clean(req.query.status, 120);
    const allowed = ['pending', 'approved', 'rejected', 'applied', 'cancelled'];
    const statuses = requested ? requested.split(',').map((value) => value.trim()).filter((value) => allowed.includes(value)) : ['pending', 'approved'];
    const query = supabase.from('subscription_change_requests').select('*,academias(id,nombre,plan,plan_codigo,billing_cycle,next_billing_date,licencia_apoderados)')
      .order('requested_at', { ascending: false }).limit(200);
    const { data, error } = statuses.length ? await query.in('status', statuses) : await query;
    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'No fue posible cargar las solicitudes de cambio.' });
  }
});

router.patch('/subscription-change-requests/:id', async (req, res) => {
  try {
    const action = String(req.body?.action || '').toLowerCase();
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Acción no válida.' });
    const { data: request, error: requestError } = await supabase.from('subscription_change_requests').select('*').eq('id', req.params.id).maybeSingle();
    if (requestError || !request) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    if (request.status !== 'pending') return res.status(409).json({ error: 'La solicitud ya fue revisada.', code: 'REQUEST_ALREADY_REVIEWED' });

    const academy = await getAcademyContract(request.academia_id);
    const now = new Date().toISOString();
    if (action === 'reject') {
      const { data, error } = await supabase.from('subscription_change_requests').update({
        status: 'rejected',
        reviewed_by: req.user.id,
        review_notes: clean(req.body?.notes, 1000) || null,
        reviewed_at: now,
        updated_at: now,
      }).eq('id', request.id).eq('status', 'pending').select('*').single();
      if (error) throw error;
      return res.json({ success: true, data });
    }

    const effectiveFrom = academy.next_billing_date || request.effective_from;
    const { data: approved, error: approveError } = await supabase.from('subscription_change_requests').update({
      status: 'approved',
      effective_from: effectiveFrom,
      reviewed_by: req.user.id,
      review_notes: clean(req.body?.notes, 1000) || null,
      reviewed_at: now,
      updated_at: now,
    }).eq('id', request.id).eq('status', 'pending').select('*').single();
    if (approveError) throw approveError;

    await cancelRenewalForEffectiveDate(academy.id, effectiveFrom);
    const refreshedAcademy = await getAcademyContract(academy.id);
    const renewal = await ensureRenewalChargeForAcademy(refreshedAcademy);
    return res.json({ success: true, data: approved, renewal: renewal || null });
  } catch (error) {
    console.error('Error revisando cambio de contrato:', error?.message || error);
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible revisar la solicitud.', code: error?.code });
  }
});

router.get('/cobros', async (_req, res) => {
  const { data, error } = await supabase.from('plataforma_cobros')
    .select('*,academias(id,nombre,plan)').order('fecha_emision', { ascending: false }).limit(300);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data: data || [] });
});

router.post('/cobros', async (req, res) => {
  const subtotal = Math.round(number(req.body.subtotal_clp));
  const addon = Math.round(number(req.body.addon_clp));
  if (!req.body.academia_id || !String(req.body.concepto || '').trim() || subtotal + addon <= 0) {
    return res.status(400).json({ error: 'Academia, concepto y monto son obligatorios.' });
  }
  const { data, error } = await supabase.from('plataforma_cobros').insert({
    academia_id: req.body.academia_id,
    concepto: String(req.body.concepto).trim().slice(0, 180),
    subtotal_clp: subtotal,
    addon_clp: addon,
    fecha_vencimiento: req.body.fecha_vencimiento,
    notas: String(req.body.notas || '').trim().slice(0, 1000) || null,
    created_by: req.user.id,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ success: true, data });
});

router.patch('/cobros/:id/pagado', async (req, res) => {
  try {
    const { data: charge, error: chargeError } = await supabase.from('plataforma_cobros')
      .select('*').eq('id', req.params.id).maybeSingle();
    if (chargeError || !charge) return res.status(404).json({ error: 'Cobro no encontrado.' });
    if (charge.estado === 'pagado') {
      await lockContractFromCharge(charge);
      await ensureSubscriptionExpense({ charge, method: charge.metodo_pago || 'Mercado Pago', reference: charge.referencia || null, paidAt: charge.pagado_at || new Date().toISOString() });
      return res.json({ success: true, alreadyPaid: true });
    }
    if (charge.estado === 'anulado') return res.status(409).json({ error: 'El cobro fue anulado y no puede marcarse como pagado.' });

    await ensureFounderReservationBeforePayment(charge);
    const method = String(req.body.metodo_pago || 'Mercado Pago').slice(0, 80);
    const reference = String(req.body.referencia || '').slice(0, 120) || null;
    const paidAt = new Date().toISOString();
    const { data, error } = await supabase.rpc('marcar_cobro_plataforma_pagado', {
      p_cobro_id: charge.id,
      p_created_by: req.user.id,
      p_metodo_pago: method,
      p_referencia: reference,
    });
    if (error) throw error;

    const licenseActivated = await activateChargePlan({ ...charge, pagado_at: paidAt });
    await lockContractFromCharge(charge);
    const expenseId = await ensureSubscriptionExpense({ charge, method, reference, paidAt });
    res.json({ success: true, movementId: data, licenseActivated, expenseId });
  } catch (error) {
    res.status(error?.status || 500).json({
      error: error.message || 'No fue posible validar el pago.',
      code: error?.code || undefined,
    });
  }
});

router.get('/movimientos', async (_req, res) => {
  const { data, error } = await supabase.from('plataforma_movimientos')
    .select('*,academias(id,nombre)').order('fecha', { ascending: false }).order('created_at', { ascending: false }).limit(500);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data: data || [] });
});

router.post('/movimientos', async (req, res) => {
  const amount = Math.round(number(req.body.monto_clp));
  if (!['ingreso', 'egreso'].includes(req.body.tipo) || amount <= 0 || !String(req.body.descripcion || '').trim()) {
    return res.status(400).json({ error: 'Tipo, descripción y monto son obligatorios.' });
  }
  const { data, error } = await supabase.from('plataforma_movimientos').insert({
    tipo: req.body.tipo,
    academia_id: req.body.academia_id || null,
    categoria: String(req.body.categoria || 'Otros').trim().slice(0, 80),
    descripcion: String(req.body.descripcion).trim().slice(0, 240),
    monto_clp: amount,
    fecha: req.body.fecha || new Date().toISOString().slice(0, 10),
    metodo_pago: String(req.body.metodo_pago || '').trim().slice(0, 80) || null,
    referencia: String(req.body.referencia || '').trim().slice(0, 120) || null,
    notas: String(req.body.notas || '').trim().slice(0, 1000) || null,
    created_by: req.user.id,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ success: true, data });
});

router.post('/academias/:id/extender-prueba', async (req, res) => {
  const days = Math.min(Math.max(Number(req.body.dias || 7), 1), 90);
  const { data: academy, error: findError } = await supabase.from('academias')
    .select('id,trial_ends_at').eq('id', req.params.id).maybeSingle();
  if (findError || !academy) return res.status(404).json({ error: 'Academia no encontrada.' });
  const base = Math.max(Date.now(), academy.trial_ends_at ? new Date(academy.trial_ends_at).getTime() : 0);
  const update = {
    plan: 'Prueba 15 Días', subscription_status: 'trialing', estado: 'Activa',
    trial_ends_at: new Date(base + days * 24 * 60 * 60 * 1000).toISOString(),
    blocked_at: null, blocked_reason: null,
  };
  if (!academy.trial_ends_at) update.trial_started_at = new Date().toISOString();
  const { data, error } = await supabase.from('academias').update(update).eq('id', academy.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

module.exports = router;