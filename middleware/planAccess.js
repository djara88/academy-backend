const supabase = require('../config/supabase');
const { getAcademyEntitlements } = require('../services/planCatalog');

const loadAcademyEntitlements = async (req, res, next) => {
  try {
    if (!req.user?.academia_id) return res.status(403).json({ error: 'Tu usuario no está vinculado a una academia.' });
    const { data: academy, error } = await supabase.from('academias')
      .select('id,nombre,plan,plan_codigo,max_profesores,licencia_apoderados,guardian_license_ends_at,guardian_price_clp,subscription_status,trial_started_at,trial_ends_at,estado')
      .eq('id', req.user.academia_id).single();
    if (error || !academy) return res.status(404).json({ error: 'Academia no encontrada.' });
    req.academy = academy;
    req.entitlements = getAcademyEntitlements(academy);
    return next();
  } catch (error) {
    return res.status(500).json({ error: 'No fue posible validar el plan contratado.' });
  }
};

const requireFeature = (feature) => [loadAcademyEntitlements, (req, res, next) => {
  if (!req.entitlements.features.includes(feature)) {
    return res.status(403).json({
      error: feature === 'apoderados'
        ? 'Apoderados PRO no está activo para esta academia. Contrata el complemento para habilitar portal familiar, comunicaciones y solicitudes deportivas.'
        : `Esta función no está habilitada en el plan ${req.entitlements.plan.name}.`,
      code: feature === 'apoderados' ? 'GUARDIAN_ADDON_REQUIRED' : 'FEATURE_NOT_INCLUDED',
      feature,
      plan: req.entitlements.plan,
      addOns: req.entitlements.addOns,
    });
  }
  return next();
}];

module.exports = { loadAcademyEntitlements, requireFeature };
