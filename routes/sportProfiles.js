const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { resolveEvaluationProfile, PROFILES } = require('../services/evaluationCatalog');

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const ramaId = String(req.query.rama_id || '').trim();
    const role = String(req.query.role || '').trim();

    if (!ramaId) {
      return res.json({
        success: true,
        data: resolveEvaluationProfile({ discipline: 'Otro', role }),
      });
    }

    const { data: branch, error } = await supabase.from('ramas')
      .select('id,nombre,disciplina,config_evaluacion,sede_id')
      .eq('id', ramaId)
      .eq('academia_id', req.user.academia_id)
      .maybeSingle();
    if (error) throw error;
    if (!branch) return res.status(404).json({ error: 'Rama deportiva no encontrada.' });

    const profile = resolveEvaluationProfile({
      discipline: branch.disciplina,
      role,
      customConfig: branch.config_evaluacion,
    });

    return res.json({ success: true, data: { ...profile, branch } });
  } catch (error) {
    console.error('Error cargando perfil deportivo:', error?.message || 'Error desconocido');
    return res.status(500).json({ error: 'No fue posible cargar el perfil de evaluación.' });
  }
});

router.get('/catalog', (_req, res) => {
  const data = Object.values(PROFILES).map(({ roleProfiles, ...profile }) => profile);
  res.json({ success: true, data });
});

module.exports = router;
