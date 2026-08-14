const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { BILLING_PLANS, GUARDIAN_ADDON_CLP, VAT_RATE, calculateGrossClp, getBillingPlan } = require('../services/billingCatalog');
const flow = require('../services/flowGateway');

const router = express.Router();
const frontendUrl = () => process.env.FRONTEND_URL || 'https://academy-frontend-wheat.vercel.app';
const backendUrl = () => process.env.BACKEND_URL || 'https://academy-backend-kqsv.onrender.com';

const activateChargePlan = async (charge) => {
  if (!charge?.target_plan_code) return;
  const plan = getBillingPlan(charge.target_plan_code);
  if (!plan) throw new Error('El cobro no contiene un plan válido.');
  const { error } = await supabase.from('academias').update({
    plan: plan.name,
    plan_codigo: plan.code,
    max_profesores: plan.professorLimit,
    max_jugadores: plan.playerLimit || 100000,
    licencia_apoderados: charge.target_guardian_license === true,
    plan_price_clp: plan.priceClp,
    guardian_price_clp: charge.target_guardian_license ? GUARDIAN_ADDON_CLP : 0,
    subscription_status: 'active',
    estado: 'Activa',
    blocked_at: null,
    blocked_reason: null,
    next_billing_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  }).eq('id', charge.academia_id);
  if (error) throw error;
};

router.get('/plans', authMiddleware, async (req, res) => {
  const plans = Object.values(BILLING_PLANS).map((plan) => ({
    ...plan,
    grossClp: calculateGrossClp({ priceClp: plan.priceClp }),
  }));
  res.json({
    success: true,
    data: {
      plans,
      guardianAddon: {
        priceClp: GUARDIAN_ADDON_CLP,
        grossClp: calculateGrossClp({ priceClp: 0, guardians: true }),
      },
      vatRate: VAT_RATE,
      gateway: { provider: 'Flow', configured: flow.isConfigured() },
      currentSubscription: req.subscription || null,
    },
  });
});

router.post('/checkout', authMiddleware, requireDirector, async (req, res) => {
  try {
    if (!flow.isConfigured()) {
      return res.status(503).json({
        error: 'La contratación en línea está preparada, pero falta conectar las credenciales comerciales de Flow.',
        code: 'FLOW_NOT_CONFIGURED',
      });
    }
    const plan = getBillingPlan(String(req.body.plan_code || ''));
    if (!plan) return res.status(400).json({ error: 'Selecciona un plan válido.' });
    const guardians = req.body.guardian_license === true;
    const subtotal = calculateGrossClp({ priceClp: plan.priceClp });
    const addon = guardians ? calculateGrossClp({ priceClp: 0, guardians: true }) : 0;
    const { data: charge, error: chargeError } = await supabase.from('plataforma_cobros').insert({
      academia_id: req.user.academia_id,
      concepto: `Suscripción Syncademia · ${plan.name}`,
      subtotal_clp: subtotal,
      addon_clp: addon,
      target_plan_code: plan.code,
      target_guardian_license: guardians,
      fecha_vencimiento: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      created_by: req.user.id,
    }).select().single();
    if (chargeError) throw chargeError;

    const result = await flow.createPayment({
      commerceOrder: charge.id,
      subject: charge.concepto,
      currency: 'CLP',
      amount: Number(charge.total_clp),
      email: req.user.email,
      urlConfirmation: `${backendUrl()}/api/subscriptions/flow/confirmation`,
      urlReturn: `${backendUrl()}/api/subscriptions/flow/return`,
    });
    const checkoutUrl = `${result.url}?token=${encodeURIComponent(result.token)}`;
    await supabase.from('plataforma_cobros').update({
      flow_order: result.flowOrder, flow_token: result.token, checkout_url: checkoutUrl,
      updated_at: new Date().toISOString(),
    }).eq('id', charge.id);
    res.status(201).json({ success: true, data: { chargeId: charge.id, checkoutUrl } });
  } catch (error) {
    res.status(error.code === 'FLOW_NOT_CONFIGURED' ? 503 : 500).json({ error: error.message });
  }
});

router.post('/flow/confirmation', async (req, res) => {
  try {
    const token = String(req.body.token || '');
    if (!token) return res.status(400).send('Token requerido');
    const payment = await flow.getPaymentStatus(token);
    const { data: charge, error } = await supabase.from('plataforma_cobros')
      .select('*').eq('flow_token', token).maybeSingle();
    if (error || !charge) return res.status(404).send('Cobro no encontrado');
    if (String(payment.commerceOrder || '') !== String(charge.id)) return res.status(409).send('Orden no coincide');
    if (Number(payment.status) === 2) {
      const { error: paymentError } = await supabase.rpc('marcar_cobro_plataforma_pagado', {
        p_cobro_id: charge.id,
        p_created_by: charge.created_by,
        p_metodo_pago: payment.paymentData?.media || 'Flow',
        p_referencia: String(payment.flowOrder || charge.flow_order || ''),
      });
      if (paymentError) throw paymentError;
      await activateChargePlan(charge);
    } else if ([3, 4].includes(Number(payment.status))) {
      await supabase.from('plataforma_cobros').update({ estado: 'anulado', updated_at: new Date().toISOString() }).eq('id', charge.id);
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('Error procesando confirmación Flow:', error.message);
    res.status(500).send('ERROR');
  }
});

const flowReturn = async (req, res) => {
  const token = encodeURIComponent(String(req.body.token || req.query.token || ''));
  res.redirect(303, `${frontendUrl()}/suscripcion?flow_token=${token}`);
};
router.get('/flow/return', flowReturn);
router.post('/flow/return', flowReturn);

router.get('/payment-status', authMiddleware, requireDirector, async (req, res) => {
  try {
    const token = String(req.query.token || '');
    const { data, error } = await supabase.from('plataforma_cobros')
      .select('id,concepto,total_clp,estado,target_plan_code,target_guardian_license,pagado_at')
      .eq('academia_id', req.user.academia_id).eq('flow_token', token).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Pago no encontrado.' });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: 'No fue posible consultar el pago.' });
  }
});

module.exports = router;
