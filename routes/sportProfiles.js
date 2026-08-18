const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { loadAcademyEntitlements } = require('../middleware/planAccess');
const { FEATURES } = require('../services/planCatalog');
const {
  resolveEvaluationProfile,
  sanitizeCustomEvaluationConfig,
  PROFILES,
} = require('../services/evaluationCatalog');
const {
  resolveCompetitiveProfile,
  aggregateCompetitiveStats,
  publicProfile,
} = require('../services/competitiveStatsCatalog');

const router = express.Router();
router.use(authMiddleware);

const canCustomizeEvaluations = (req) => Boolean(
  req.entitlements?.features?.includes(FEATURES.CUSTOM_EVALUATION_CRITERIA),
);

const getBranch = async (academyId, branchId) => {
  const { data, error } = await supabase.from('ramas')
    .select('id,nombre,disciplina,config_evaluacion,sede_id')
    .eq('id', branchId)
    .eq('academia_id', academyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const notFound = new Error('Rama deportiva no encontrada.');
    notFound.status = 404;
    throw notFound;
  }
  return data;
};

router.get('/', loadAcademyEntitlements, async (req, res) => {
  try {
    const ramaId = String(req.query.rama_id || '').trim();
    const role = String(req.query.role || '').trim();
    const customizationAllowed = canCustomizeEvaluations(req);

    if (!ramaId) {
      return res.json({
        success: true,
        data: {
          ...resolveEvaluationProfile({ discipline: 'Otro', role }),
          customization: { allowed: customizationAllowed, active: false },
        },
      });
    }

    const branch = await getBranch(req.user.academia_id, ramaId);
    const effectiveConfig = customizationAllowed ? branch.config_evaluacion : {};
    const profile = resolveEvaluationProfile({
      discipline: branch.disciplina,
      role,
      customConfig: effectiveConfig,
      scopeId: branch.id,
    });

    return res.json({
      success: true,
      data: {
        ...profile,
        branch: {
          id: branch.id,
          nombre: branch.nombre,
          disciplina: branch.disciplina,
          sede_id: branch.sede_id,
        },
        competitive: publicProfile(resolveCompetitiveProfile({ discipline: branch.disciplina })),
        customization: {
          allowed: customizationAllowed,
          active: customizationAllowed && profile.custom,
          version: customizationAllowed && profile.custom ? profile.metricVersion : null,
        },
      },
    });
  } catch (error) {
    console.error('Error cargando perfil deportivo:', error?.message || 'Error desconocido');
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible cargar el perfil de evaluación.' });
  }
});

router.put('/branch/:ramaId/evaluation-config', loadAcademyEntitlements, requireDirector, async (req, res) => {
  try {
    if (!canCustomizeEvaluations(req)) {
      return res.status(403).json({
        error: `Los criterios de evaluación personalizados están disponibles desde Competencia. Tu plan actual es ${req.entitlements.plan.name}.`,
        code: 'CUSTOM_EVALUATION_CRITERIA_NOT_INCLUDED',
        feature: FEATURES.CUSTOM_EVALUATION_CRITERIA,
        plan: req.entitlements.plan,
      });
    }

    const branch = await getBranch(req.user.academia_id, String(req.params.ramaId || '').trim());
    const previousConfig = branch.config_evaluacion && typeof branch.config_evaluacion === 'object'
      ? branch.config_evaluacion
      : {};
    const previousVersion = Number(previousConfig.version || 0);
    const nextConfig = sanitizeCustomEvaluationConfig({ metrics: req.body?.metrics }, previousVersion);
    const previousMetrics = Array.isArray(previousConfig.metrics) ? previousConfig.metrics.map(String) : [];
    if (JSON.stringify(previousMetrics) === JSON.stringify(nextConfig.metrics)) {
      nextConfig.version = Math.max(1, previousVersion || 1);
    }
    nextConfig.updated_at = new Date().toISOString();
    nextConfig.updated_by = req.user.id;

    const { data, error } = await supabase.from('ramas')
      .update({ config_evaluacion: nextConfig, updated_at: new Date().toISOString() })
      .eq('id', branch.id)
      .eq('academia_id', req.user.academia_id)
      .select('id,nombre,disciplina,sede_id,config_evaluacion')
      .single();
    if (error) throw error;

    const profile = resolveEvaluationProfile({
      discipline: data.disciplina,
      customConfig: data.config_evaluacion,
      scopeId: data.id,
    });
    return res.json({
      success: true,
      data: {
        profile,
        branch: { id: data.id, nombre: data.nombre, disciplina: data.disciplina, sede_id: data.sede_id },
        customization: { allowed: true, active: true, version: profile.metricVersion },
      },
    });
  } catch (error) {
    console.error('Error guardando criterios de evaluación:', error?.message || 'Error desconocido');
    return res.status(error?.status || 500).json({
      error: error?.message || 'No fue posible guardar los criterios de evaluación.',
      code: error?.code || undefined,
    });
  }
});

router.delete('/branch/:ramaId/evaluation-config', loadAcademyEntitlements, requireDirector, async (req, res) => {
  try {
    if (!canCustomizeEvaluations(req)) {
      return res.status(403).json({
        error: `Los criterios de evaluación personalizados están disponibles desde Competencia. Tu plan actual es ${req.entitlements.plan.name}.`,
        code: 'CUSTOM_EVALUATION_CRITERIA_NOT_INCLUDED',
      });
    }

    const branch = await getBranch(req.user.academia_id, String(req.params.ramaId || '').trim());
    const { data, error } = await supabase.from('ramas')
      .update({ config_evaluacion: {}, updated_at: new Date().toISOString() })
      .eq('id', branch.id)
      .eq('academia_id', req.user.academia_id)
      .select('id,nombre,disciplina,sede_id')
      .single();
    if (error) throw error;

    const profile = resolveEvaluationProfile({ discipline: data.disciplina });
    return res.json({
      success: true,
      data: {
        profile,
        branch: data,
        customization: { allowed: true, active: false, version: null },
      },
    });
  } catch (error) {
    console.error('Error restaurando criterios estándar:', error?.message || 'Error desconocido');
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible restaurar los criterios estándar.' });
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