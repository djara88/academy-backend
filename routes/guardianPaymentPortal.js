const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireGuardian } = require('../middleware/professorAccess');
const { requireFeature } = require('../middleware/planAccess');
const { FEATURES } = require('../services/planCatalog');
const { createPortalToken } = require('../services/collectionPortal');

const router = express.Router();
const guardianFeature = requireFeature(FEATURES.GUARDIANS);

router.use(authMiddleware, requireGuardian, ...guardianFeature);

router.post('/token', async (req, res) => {
  try {
    const academiaId = req.user?.academia_id;
    const userId = req.user?.id;
    if (!academiaId || !userId) return res.status(401).json({ error: 'No fue posible validar tu sesión.' });

    const [{ data: tutor, error: tutorError }, { data: config, error: configError }] = await Promise.all([
      supabase.from('tutores')
        .select('id')
        .eq('usuario_id', userId)
        .eq('academia_id', academiaId)
        .eq('acceso_activo', true)
        .maybeSingle(),
      supabase.from('configuracion_financiera')
        .select('acepta_pago_online')
        .eq('academia_id', academiaId)
        .maybeSingle(),
    ]);

    if (tutorError) throw tutorError;
    if (configError) throw configError;
    if (!tutor) return res.status(403).json({ error: 'Tu acceso de apoderado no está activo.' });
    if (config?.acepta_pago_online !== true) return res.status(409).json({ error: 'La academia no tiene pagos en línea habilitados.' });

    const portal = await createPortalToken({
      academyId: academiaId,
      tutorId: tutor.id,
      via: 'portal_apoderado',
      userId,
      ttlMinutes: 10,
    });

    return res.status(201).json({
      success: true,
      data: { token: portal.token, expiresAt: portal.expiresAt },
    });
  } catch (error) {
    console.error('Error creando token de pago para apoderado:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible iniciar el pago en línea.' });
  }
});

module.exports = router;
