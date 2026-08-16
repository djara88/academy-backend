const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const {
  resolveEvaluationProfile,
  sanitizeRadarMetrics,
  selectComparableEvaluations,
} = require('../services/evaluationCatalog');

const resolvePlayerProfile = async (academiaId, jugadorId) => {
  const { data: player, error: playerError } = await supabase.from('jugadores')
    .select('id,sede_id,rama_id,posicion_cancha')
    .eq('id', jugadorId)
    .eq('academia_id', academiaId)
    .maybeSingle();
  if (playerError) throw playerError;
  if (!player) {
    const error = new Error('Jugador no encontrado.');
    error.status = 404;
    throw error;
  }

  let branch = null;
  if (player.rama_id) {
    const { data, error } = await supabase.from('ramas')
      .select('id,disciplina,config_evaluacion')
      .eq('id', player.rama_id)
      .eq('academia_id', academiaId)
      .maybeSingle();
    if (error) throw error;
    branch = data || null;
  }

  const profile = resolveEvaluationProfile({
    discipline: branch?.disciplina || 'Otro',
    role: player.posicion_cancha || '',
    customConfig: branch?.config_evaluacion || {},
  });
  return { player, branch, profile };
};

router.get('/jugador/:jugadorId', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('evaluaciones')
      .select('*')
      .eq('jugador_id', req.params.jugadorId)
      .eq('academia_id', req.user.academia_id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    const evaluations = data || [];
    res.json({
      success: true,
      data: evaluations,
      comparable: selectComparableEvaluations(evaluations),
    });
  } catch (_error) {
    res.status(500).json({ success: false, error: 'No fue posible cargar las evaluaciones.' });
  }
});

router.get('/categorias/:categoriaId/promedio', authMiddleware, async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const categoryId = String(req.params.categoriaId || '').trim();
    const { data: category, error: categoryError } = await supabase.from('categorias')
      .select('id,rama_id')
      .eq('id', categoryId)
      .eq('academia_id', academyId)
      .maybeSingle();
    if (categoryError) throw categoryError;
    if (!category) return res.status(404).json({ error: 'Categoría no encontrada.' });

    let branch = null;
    if (category.rama_id) {
      const { data, error } = await supabase.from('ramas')
        .select('id,disciplina,config_evaluacion')
        .eq('id', category.rama_id)
        .eq('academia_id', academyId)
        .maybeSingle();
      if (error) throw error;
      branch = data || null;
    }
    const profile = resolveEvaluationProfile({
      discipline: branch?.disciplina || 'Otro',
      customConfig: branch?.config_evaluacion || {},
    });

    const { data: links, error: linkError } = await supabase.from('jugador_categoria')
      .select('jugador_id')
      .eq('categoria_id', category.id);
    if (linkError) throw linkError;
    const linkedIds = [...new Set((links || []).map((row) => row.jugador_id).filter(Boolean))];
    if (!linkedIds.length) return res.json({ success: true, data: {}, sample_size: 0, profile });

    let playersQuery = supabase.from('jugadores')
      .select('id,rama_id')
      .eq('academia_id', academyId)
      .in('id', linkedIds);
    if (category.rama_id) playersQuery = playersQuery.eq('rama_id', category.rama_id);
    const { data: players, error: playersError } = await playersQuery;
    if (playersError) throw playersError;
    const playerIds = (players || []).map((row) => row.id);
    if (!playerIds.length) return res.json({ success: true, data: {}, sample_size: 0, profile });

    const { data: evaluations, error: evalError } = await supabase.from('evaluaciones')
      .select('jugador_id,datos_radar,perfil_evaluacion,metricas_version,created_at')
      .eq('academia_id', academyId)
      .in('jugador_id', playerIds)
      .order('created_at', { ascending: false });
    if (evalError) throw evalError;

    const latestByPlayer = new Map();
    for (const evaluation of evaluations || []) {
      if (latestByPlayer.has(evaluation.jugador_id)) continue;
      const exactProfile = evaluation.perfil_evaluacion === profile.profileCode
        && Number(evaluation.metricas_version || 1) === Number(profile.metricVersion);
      const sanitized = sanitizeRadarMetrics(evaluation.datos_radar, profile.metrics);
      const legacyCompatible = !evaluation.perfil_evaluacion
        && Object.keys(sanitized).length === profile.metrics.length;
      if (exactProfile || legacyCompatible) latestByPlayer.set(evaluation.jugador_id, sanitized);
    }

    const totals = {};
    const counts = {};
    for (const radar of latestByPlayer.values()) {
      for (const metric of profile.metrics) {
        const value = Number(radar?.[metric]);
        if (!Number.isFinite(value)) continue;
        totals[metric] = (totals[metric] || 0) + value;
        counts[metric] = (counts[metric] || 0) + 1;
      }
    }
    const average = {};
    for (const metric of profile.metrics) {
      if (counts[metric]) average[metric] = Math.round(totals[metric] / counts[metric]);
    }

    res.json({
      success: true,
      data: average,
      sample_size: latestByPlayer.size,
      profile,
    });
  } catch (error) {
    console.error('Error calculando promedio de categoría:', error?.message || 'Error desconocido');
    res.status(500).json({ error: 'No fue posible calcular el promedio de la categoría.' });
  }
});

router.post('/', authMiddleware, async (req, res) => {
  try {
    const jugadorId = String(req.body?.jugador_id || '').trim();
    if (!jugadorId) return res.status(400).json({ error: 'Jugador requerido.' });

    const { player, profile } = await resolvePlayerProfile(req.user.academia_id, jugadorId);
    const sourceMetrics = req.body?.datos_radar || req.body?.metricas_json || {};
    const metrics = sanitizeRadarMetrics(sourceMetrics, profile.metrics);
    if (Object.keys(metrics).length < 3) {
      return res.status(400).json({
        error: 'La evaluación debe contener al menos tres métricas válidas para la disciplina del alumno.',
        code: 'INVALID_EVALUATION_METRICS',
      });
    }

    const { data, error } = await supabase.from('evaluaciones').insert([{
      academia_id: req.user.academia_id,
      jugador_id: jugadorId,
      sede_id: player.sede_id || null,
      rama_id: player.rama_id || null,
      datos_radar: metrics,
      comentarios_profesor: String(req.body?.comentarios_profesor || req.body?.comentarios || '').trim().slice(0, 3000) || null,
      disciplina_codigo: profile.code,
      perfil_evaluacion: profile.profileCode,
      metricas_version: profile.metricVersion,
      fecha_evaluacion: new Date().toISOString(),
    }]).select().single();
    if (error) throw error;

    res.status(201).json({ success: true, data, profile });
  } catch (error) {
    console.error('Error guardando evaluación:', error?.message || 'Error desconocido');
    res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible guardar la evaluación.' });
  }
});

module.exports = router;
