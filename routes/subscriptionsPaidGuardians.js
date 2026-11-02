const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { catalog, checkoutEnabled } = require('../services/deportivoOffer');
const { PLATFORM_ACCESS_TOKEN } = require('../services/mercadoPagoGateway');
const router = express.Router();
const clean = (value, max = 160) => String(value || '').trim().replace(/[\r\n|]+/g, ' ').slice(0, max);

router.get('/plans', authMiddleware, (req, res) => {
  res.json({ success: true, data: {
    ...catalog,
    currentSubscription: req.subscription || null,
    checkoutEnabled: checkoutEnabled() && Boolean(PLATFORM_ACCESS_TOKEN()),
  } });
});

const legacyCheckoutDisabled = (_req, res) => res.status(410).json({
  error: 'Este flujo de contratación fue reemplazado por el contrato administrado de Lestra. Actualiza la pantalla e intenta nuevamente.',
  code: 'LEGACY_CHECKOUT_DISABLED',
});

router.post('/checkout', authMiddleware, requireDirector, legacyCheckoutDisabled);
router.post('/guardian-addon/checkout', authMiddleware, requireDirector, legacyCheckoutDisabled);

router.patch('/payment-notice/:chargeId', authMiddleware, requireDirector, async (req, res) => {
  try {
    const { data: charge, error: findError } = await supabase.from('plataforma_cobros').select('id,estado,notas').eq('id', req.params.chargeId).eq('academia_id', req.user.academia_id).maybeSingle();
    if (findError) throw findError;
    if (!charge) return res.status(404).json({ error: 'Cobro no encontrado.' });
    if (charge.estado === 'pagado') return res.json({ success: true, alreadyPaid: true });
    if (charge.estado === 'anulado') return res.status(409).json({ error: 'El cobro fue anulado.' });
    const payer = clean(req.body.payer_name, 120);
    const reference = clean(req.body.reference, 120);
    const notice = [`Cliente informó pago ${new Date().toISOString()}.`, payer ? `Pagador: ${payer}.` : null, reference ? `Referencia: ${reference}.` : null].filter(Boolean).join(' ');
    const { error } = await supabase.from('plataforma_cobros').update({ notas: `${clean(charge.notas, 700)} ${notice}`.trim().slice(0, 1000), updated_at: new Date().toISOString() }).eq('id', charge.id).eq('academia_id', req.user.academia_id);
    if (error) throw error;
    return res.json({ success: true, status: 'pending_validation' });
  } catch (_error) {
    return res.status(500).json({ error: 'No fue posible informar el pago.' });
  }
});

router.get('/payment-status', authMiddleware, requireDirector, async (req, res) => {
  try {
    const chargeId = String(req.query.chargeId || '');
    if (!chargeId) return res.status(400).json({ error: 'Cobro requerido.' });
    const { data, error } = await supabase.from('plataforma_cobros')
      .select('id,concepto,total_clp,estado,target_plan_code,target_guardian_license,pagado_at,fecha_vencimiento,notas,billing_cycle,billing_period_months,promotion_code,discount_clp,founder_slot,charge_kind,billing_document_type')
      .eq('academia_id', req.user.academia_id).eq('id', chargeId).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Pago no encontrado.' });
    return res.json({ success: true, data });
  } catch (_error) {
    return res.status(500).json({ error: 'No fue posible consultar el pago.' });
  }
});

module.exports = router;
