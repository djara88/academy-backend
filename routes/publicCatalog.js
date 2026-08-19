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

router.get('/academias/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim().toLowerCase();
    if (!slug) return res.status(404).json({ error: 'Academia no encontrada.' });
    const { data: academy, error } = await supabase.from('academias')
      .select('id,nombre,subdominio,descripcion_publica,logo,logo_url,direccion,ciudad,telefono,correo_academia,pagina_publica_activa,estado')
      .ilike('subdominio', slug).maybeSingle();
    if (error) throw error;
    if (!academy || academy.pagina_publica_activa !== true || String(academy.estado || '').toLowerCase() === 'inactiva') {
      return res.status(404).json({ error: 'Academia no encontrada.' });
    }

    const [{ data: branches, error: branchError }, { data: categories, error: categoryError }, { data: sites, error: siteError }] = await Promise.all([
      supabase.from('ramas').select('id,nombre,disciplina,sede_id').eq('academia_id', academy.id).eq('activa', true).order('nombre'),
      supabase.from('categorias').select('id,nombre,rama_id,sede_id').eq('academia_id', academy.id).order('nombre'),
      supabase.from('sedes').select('id,nombre,direccion,ciudad,comuna,ubicacion_entrenamiento,dias_entrenamiento,horarios_entrenamiento').eq('academia_id', academy.id).eq('activa', true).order('principal', { ascending: false }).order('nombre'),
    ]);
    if (branchError) throw branchError;
    if (categoryError) throw categoryError;
    if (siteError) throw siteError;

    const activeBranchIds = new Set((branches || []).map((item) => String(item.id)));
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return res.json({ success: true, data: {
      academia: {
        nombre: academy.nombre,
        slug: academy.subdominio,
        descripcion: academy.descripcion_publica || null,
        logo: academy.logo_url || academy.logo || null,
        direccion: academy.direccion || null,
        ciudad: academy.ciudad || null,
        telefono: academy.telefono || null,
        correo: academy.correo_academia || null,
      },
      sedes: sites || [],
      ramas: branches || [],
      categorias: (categories || []).filter((item) => activeBranchIds.has(String(item.rama_id))),
    } });
  } catch (error) {
    console.error('Error cargando academia pública:', error?.message || 'Error desconocido');
    return res.status(500).json({ error: 'No fue posible cargar esta academia.' });
  }
});

module.exports = router;
