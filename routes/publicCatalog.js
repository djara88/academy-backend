const express = require('express');
const supabase = require('../config/supabase');
const {
  BILLING_PLANS,
  VAT_RATE,
  GUARDIAN_ADDON_CLP,
  FOUNDER_SLOTS,
  publicPlanPricing,
  guardianAddonQuote,
} = require('../services/billingCatalog');

const router = express.Router();

router.get('/plans', async (_req, res) => {
  try {
    const { data: slots, error: slotError } = await supabase
      .from('syncademia_founder_slots')
      .select('slot_no,academia_id,reserved_until,activated_at')
      .order('slot_no');
    if (slotError) throw slotError;

    const now = Date.now();
    const remainingSlots = (slots || []).filter((slot) => {
      if (!slot.academia_id) return true;
      if (slot.activated_at) return false;
      return Boolean(slot.reserved_until && new Date(slot.reserved_until).getTime() < now);
    }).length;

    const plans = Object.values(BILLING_PLANS).map((plan) => publicPlanPricing(plan));
    const guardianMonthly = guardianAddonQuote('monthly');
    const guardianAnnual = guardianAddonQuote('annual');

    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.json({ success: true, data: {
      plans,
      guardianAddon: {
        name: 'Apoderados PRO', priceClp: GUARDIAN_ADDON_CLP,
        monthly: guardianMonthly, annual: guardianAnnual, trialIncluded: true,
      },
      vatRate: VAT_RATE,
      founder: { available: remainingSlots > 0, remainingSlots, totalSlots: FOUNDER_SLOTS },
      billingRules: { annualMonthsCharged: 10, annualMonthsIncluded: 12, founderDurationMonths: 12, discountsStackable: false },
    } });
  } catch (error) {
    console.error('Error cargando catálogo público:', error?.message || 'Error desconocido');
    res.status(500).json({ error: 'No fue posible cargar el catálogo público.' });
  }
});

module.exports = router;
