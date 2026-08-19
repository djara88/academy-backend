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
      .select('id,nombre,subdominio,descripcion_publica,logo,logo_url,direccion,ciudad,telefono,correo_academia,pagina_publica_activa,estado,pagina_color_primario,pagina_color_secundario,pagina_color_fondo,pagina_rrss')
      .ilike('subdominio', slug).maybeSingle();
    if (error) throw error;
    if (!academy || academy.pagina_publica_activa !== true || String(academy.estado || '').toLowerCase() === 'inactiva') {
      return res.status(404).json({ error: 'Academia no encontrada.' });
    }

    const [branchesResult, categoriesResult, sitesResult, photosResult] = await Promise.all([
      supabase.from('ramas').select('id,nombre,disciplina,sede_id').eq('academia_id', academy.id).eq('activa', true).order('nombre'),
      supabase.from('categorias').select('id,nombre,rama_id,sede_id').eq('academia_id', academy.id).order('nombre'),
      supabase.from('sedes').select('id,nombre,direccion,ciudad,comuna,ubicacion_entrenamiento,dias_entrenamiento,horarios_entrenamiento').eq('academia_id', academy.id).eq('activa', true).order('principal', { ascending: false }).order('nombre'),
      supabase.from('academia_pagina_fotos').select('id,url,alt_text,orden').eq('academia_id', academy.id).order('orden').order('created_at'),
    ]);
    for (const result of [branchesResult, categoriesResult, sitesResult, photosResult]) if (result.error) throw result.error;

    const branches = branchesResult.data || [];
    const activeBranchIds = new Set(branches.map((item) => String(item.id)));
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
        colores: {
          primario: academy.pagina_color_primario || '#289E9D',
          secundario: academy.pagina_color_secundario || '#70E4DF',
          fondo: academy.pagina_color_fondo || '#0D1117',
        },
        rrss: academy.pagina_rrss || {},
      },
      fotos: photosResult.data || [],
      sedes: sitesResult.data || [],
      ramas: branches,
      categorias: (categoriesResult.data || []).filter((item) => activeBranchIds.has(String(item.rama_id))),
    } });
  } catch (error) {
    console.error('Error cargando academia pública:', error?.message || 'Error desconocido');
    return res.status(500).json({ error: 'No fue posible cargar esta academia.' });
  }
});

module.exports = router;
