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
  guardianAddonQuote,
} = require('../services/billingCatalog');

const router = express.Router();
const clean = (value, max = 160) => String(value || '').trim().replace(/[\r\n|]+/g, ' ').slice(0, max);
const today = () => new Date().toISOString().slice(0, 10);

const getPromotionState = async (academyId) => {
  const [{ data: academy, error: academyError }, { data: slots, error: slotError }] = await Promise.all([
    supabase.from('academias')
      .select('id,plan,plan_codigo,billing_cycle,billing_amount_clp,promotion_code,promotion_ends_at,founder_number,subscription_status,licencia_apoderados,guardian_price_clp,guardian_license_ends_at,trial_ends_at,contract_locked_at,next_billing_date')
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
      vatRate: VAT_RATE,
      founder: state.founder,
      billingRules: { annualMonthsCharged: 10, annualMonthsIncluded: 12, founderDurationMonths: 12, discountsStackable: false },
      currentSubscription: req.subscription || null,
      contract: {
        locked: Boolean(state.academy.contract_locked_at),
        nextBillingDate: state.academy.next_billing_date || null,
      },
    } });
  } catch (error) {
    console.error('Error cargando planes:', error?.message || 'Error desconocido');
    res.status(500).json({ error: 'No fue posible cargar los planes.' });
  }
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
