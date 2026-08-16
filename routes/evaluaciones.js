const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { resolveEvaluationProfile, sanitizeRadarMetrics } = require('../services/evaluationCatalog');

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
    res.json({ success: true, data: data || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: 'No fue posible cargar las evaluaciones.' });
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
