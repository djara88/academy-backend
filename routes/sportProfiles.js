const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { resolveEvaluationProfile, PROFILES } = require('../services/evaluationCatalog');
const {
  resolveCompetitiveProfile,
  aggregateCompetitiveStats,
} = require('../services/competitiveStatsCatalog');

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

router.get('/player/:jugadorId/competitive-stats', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const playerId = String(req.params.jugadorId || '').trim();
    const { data: player, error: playerError } = await supabase.from('jugadores')
      .select('id,rama_id')
      .eq('id', playerId)
      .eq('academia_id', academyId)
      .maybeSingle();
    if (playerError) throw playerError;
    if (!player) return res.status(404).json({ error: 'Deportista no encontrado.' });

    let branch = null;
    if (player.rama_id) {
      const { data, error } = await supabase.from('ramas')
        .select('id,nombre,disciplina')
        .eq('id', player.rama_id)
        .eq('academia_id', academyId)
        .maybeSingle();
      if (error) throw error;
      branch = data || null;
    }

    const profile = resolveCompetitiveProfile({ discipline: branch?.disciplina || 'Otro' });
    const { data: rows, error: statsError } = await supabase.from('partido_estadisticas')
      .select('disciplina_codigo,metricas_competitivas,metricas_version,goles,asistencias,tarjetas_amarillas,tarjetas_rojas,es_mvp,created_at')
      .eq('jugador_id', player.id)
      .order('created_at', { ascending: false });
    if (statsError) throw statsError;

    return res.json({
      success: true,
      data: {
        ...aggregateCompetitiveStats(profile, rows || []),
        branch,
      },
    });
  } catch (error) {
    console.error('Error cargando estadísticas competitivas:', error?.message || 'Error desconocido');
    return res.status(500).json({ error: 'No fue posible cargar las estadísticas competitivas.' });
  }
});

router.get('/catalog', (_req, res) => {
  const data = Object.values(PROFILES).map(({ roleProfiles, ...profile }) => profile);
  res.json({ success: true, data });
});

module.exports = router;
