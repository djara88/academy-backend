const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { BILLING_PLANS, GUARDIAN_ADDON_CLP, VAT_RATE, calculateGrossClp, getBillingPlan } = require('../services/billingCatalog');

const router = express.Router();
const mercadoPagoLink = () => String(process.env.MERCADO_PAGO_PAYMENT_LINK || 'https://link.mercadopago.cl/smproweb').trim();
const mercadoPagoConfigured = () => /^https:\/\/link\.mercadopago\.cl\/[A-Za-z0-9._-]+$/i.test(mercadoPagoLink());
const clean = (value, max = 160) => String(value || '').trim().replace(/[\r\n|]+/g, ' ').slice(0, max);

router.get('/plans', authMiddleware, async (req, res) => {
  const plans = Object.values(BILLING_PLANS).map((plan) => ({
    ...plan,
    grossClp: calculateGrossClp({ priceClp: plan.priceClp }),
  }));

  res.json({
    success: true,
    data: {
      plans,
      // Se mantiene por compatibilidad con clientes antiguos. Desde la nueva
      // matriz el portal del apoderado está incluido y su costo adicional es 0.
      guardianAddon: {
        priceClp: GUARDIAN_ADDON_CLP,
        grossClp: 0,
        included: true,
      },
      vatRate: VAT_RATE,
      gateway: {
        provider: 'Mercado Pago',
        configured: mercadoPagoConfigured(),
        manualVerification: true,
      },
      currentSubscription: req.subscription || null,
    },
  });
});

router.post('/checkout', authMiddleware, requireDirector, async (req, res) => {
  try {
    if (!mercadoPagoConfigured()) {
      return res.status(503).json({
        error: 'El botón de Mercado Pago no está configurado correctamente.',
        code: 'MERCADOPAGO_NOT_CONFIGURED',
      });
    }

    const plan = getBillingPlan(String(req.body.plan_code || ''));
    if (!plan) return res.status(400).json({ error: 'Selecciona un plan válido.' });

    const subtotal = calculateGrossClp({ priceClp: plan.priceClp });
    const total = subtotal;

    const { data: charge, error: chargeError } = await supabase.from('plataforma_cobros').insert({
      academia_id: req.user.academia_id,
      concepto: `Suscripción Syncademia · ${plan.name}`,
      subtotal_clp: subtotal,
      addon_clp: 0,
      target_plan_code: plan.code,
      target_guardian_license: true,
      fecha_vencimiento: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      checkout_url: mercadoPagoLink(),
      notas: `Pago externo Mercado Pago. Monto esperado: $${total.toLocaleString('es-CL')} CLP. Activación sujeta a validación del administrador. Portal de apoderados incluido.`,
      created_by: req.user.id,
    }).select().single();

    if (chargeError) throw chargeError;

    res.status(201).json({
      success: true,
      data: {
        chargeId: charge.id,
        checkoutUrl: mercadoPagoLink(),
        amountClp: Number(charge.total_clp || total),
        planName: plan.name,
        guardianLicense: true,
        manualVerification: true,
        expiresAt: charge.fecha_vencimiento,
      },
    });
  } catch (error) {
    console.error('Error iniciando checkout Mercado Pago:', error.message);
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
  } catch (error) {
    res.status(500).json({ error: 'No fue posible informar el pago.' });
  }
});

router.get('/payment-status', authMiddleware, requireDirector, async (req, res) => {
  try {
    const chargeId = String(req.query.chargeId || '');
    if (!chargeId) return res.status(400).json({ error: 'Cobro requerido.' });

    const { data, error } = await supabase.from('plataforma_cobros')
      .select('id,concepto,total_clp,estado,target_plan_code,target_guardian_license,pagado_at,fecha_vencimiento,notas')
      .eq('academia_id', req.user.academia_id)
      .eq('id', chargeId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Pago no encontrado.' });

    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: 'No fue posible consultar el pago.' });
  }
});

module.exports = router;
