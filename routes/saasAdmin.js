const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireSuperadmin } = require('../middleware/authorization');
const { requireSuperadminMfa } = require('../middleware/requireMfa');
const { getSubscriptionState } = require('../services/subscriptionAccess');
const { activateChargePlan } = require('../services/subscriptionBilling');
const { getSystemMonitorSnapshot } = require('../services/systemMonitor');

const router = express.Router();
router.use(authMiddleware, requireSuperadmin, requireSuperadminMfa);

const monthBounds = () => {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  return { start, end };
};
const number = (value) => Number(value || 0);
const mercadoPagoLink = () => String(process.env.MERCADO_PAGO_PAYMENT_LINK || 'https://link.mercadopago.cl/smproweb').trim();
const mercadoPagoConfigured = () => /^https:\/\/link\.mercadopago\.cl\/[A-Za-z0-9._-]+$/i.test(mercadoPagoLink());

router.get('/monitor', async (_req, res) => {
  try {
    const data = await getSystemMonitorSnapshot();
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error cargando monitor del sistema:', error?.message || 'Error desconocido');
    res.status(500).json({ error: 'No fue posible cargar el monitor del sistema.' });
  }
});

router.get('/resumen', async (_req, res) => {
  try {
    await supabase.rpc('refrescar_pruebas_vencidas');
    const { start, end } = monthBounds();
    const [academiesResult, chargesResult, movementsResult] = await Promise.all([
      supabase.from('academias').select('id,nombre,plan,plan_codigo,estado,created_at,subscription_status,trial_started_at,trial_ends_at,blocked_at,blocked_reason,next_billing_date,plan_price_clp,guardian_price_clp,licencia_apoderados,jugadores_count,max_profesores'),
      supabase.from('plataforma_cobros').select('id,academia_id,total_clp,estado,fecha_vencimiento,pagado_at'),
      supabase.from('plataforma_movimientos').select('id,tipo,monto_clp,fecha').gte('fecha', start).lt('fecha', end),
    ]);
    if (academiesResult.error) throw academiesResult.error;
    if (chargesResult.error) throw chargesResult.error;
    if (movementsResult.error) throw movementsResult.error;
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
        conversionRate: academies.length ? Math.round((active.length / academies.length) * 100) : 0,
      },
      academies, alerts: alerts.slice(0, 30),
      gateway: { provider: 'Mercado Pago', configured: mercadoPagoConfigured(), manualVerification: true },
    } });
  } catch (error) {
    res.status(500).json({ error: error.message || 'No fue posible cargar el centro ejecutivo.' });
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
    if (charge.estado === 'pagado') return res.json({ success: true, alreadyPaid: true });

    const { data, error } = await supabase.rpc('marcar_cobro_plataforma_pagado', {
      p_cobro_id: charge.id,
      p_created_by: req.user.id,
      p_metodo_pago: String(req.body.metodo_pago || 'Mercado Pago').slice(0, 80),
      p_referencia: String(req.body.referencia || '').slice(0, 120) || null,
    });
    if (error) throw error;

    const licenseActivated = await activateChargePlan(charge);
    res.json({ success: true, movementId: data, licenseActivated });
  } catch (error) {
    res.status(500).json({ error: error.message || 'No fue posible validar el pago.' });
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
