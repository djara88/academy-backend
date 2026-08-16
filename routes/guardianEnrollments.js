const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireGuardian } = require('../middleware/professorAccess');
const { requireFeature } = require('../middleware/planAccess');
const { FEATURES } = require('../services/planCatalog');

const guardianFeature = requireFeature(FEATURES.GUARDIANS);

router.get('/', authMiddleware, requireGuardian, ...guardianFeature, async (req, res) => {
  try {
    const academiaId = req.user.academia_id;
    const { data: tutor, error: tutorError } = await supabase.from('tutores')
      .select('id')
      .eq('usuario_id', req.user.id)
      .eq('academia_id', academiaId)
      .eq('acceso_activo', true)
      .maybeSingle();
    if (tutorError) throw tutorError;
    if (!tutor) return res.status(403).json({ error: 'Tu acceso de apoderado no está activo.' });

    const [{ data: players, error: playerError }, { data: links, error: linkError }] = await Promise.all([
      supabase.from('jugadores')
        .select('id,nombre,foto_url,avatar_url,tutor_id,apoderado_id,tutor_principal_id')
        .eq('academia_id', academiaId),
      supabase.from('jugador_tutor').select('jugador_id').eq('tutor_id', tutor.id),
    ]);
    if (playerError) throw playerError;
    if (linkError) throw linkError;

    const linkedIds = new Set((links || []).map((item) => String(item.jugador_id)));
    const ownPlayers = (players || []).filter((player) => linkedIds.has(String(player.id))
      || [player.tutor_id, player.apoderado_id, player.tutor_principal_id]
        .some((id) => String(id || '') === String(tutor.id)));
    const playerIds = ownPlayers.map((player) => player.id);

    const { data: enrollments, error: enrollmentError } = playerIds.length
      ? await supabase.from('inscripciones_deportivas')
        .select('id,jugador_id,estado,fecha_inicio,monto_mensualidad,sede_id,rama_id,categoria_id,sedes(nombre),ramas(nombre,disciplina),categorias(nombre)')
        .eq('academia_id', academiaId)
        .in('jugador_id', playerIds)
        .eq('estado', 'Activa')
        .order('created_at', { ascending: true })
      : { data: [], error: null };
    if (enrollmentError) throw enrollmentError;

    const byPlayer = new Map();
    for (const enrollment of enrollments || []) {
      const list = byPlayer.get(String(enrollment.jugador_id)) || [];
      list.push(enrollment);
      byPlayer.set(String(enrollment.jugador_id), list);
    }

    return res.json({
      success: true,
      data: ownPlayers.map(({ tutor_id: _tutor, apoderado_id: _guardian, tutor_principal_id: _principal, ...player }) => ({
        ...player,
        inscripciones: byPlayer.get(String(player.id)) || [],
      })),
    });
  } catch (error) {
    console.error('Error cargando disciplinas del apoderado:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible cargar las disciplinas de tus alumnos.' });
  }
});

module.exports = router;
