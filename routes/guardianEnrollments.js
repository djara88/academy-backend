const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireGuardian } = require('../middleware/professorAccess');
const { requireFeature } = require('../middleware/planAccess');
const { FEATURES } = require('../services/planCatalog');
const { updateTournamentParticipation, updateCitation } = require('../services/sportsResponseService');

const guardianFeature = requireFeature(FEATURES.GUARDIANS);
router.use(authMiddleware, requireGuardian, ...guardianFeature);

const loadGuardianContext = async (user) => {
  const academiaId = user.academia_id;
  const { data: tutor, error: tutorError } = await supabase.from('tutores')
    .select('id').eq('usuario_id', user.id).eq('academia_id', academiaId).eq('acceso_activo', true).maybeSingle();
  if (tutorError) throw tutorError;
  if (!tutor) throw Object.assign(new Error('Tu acceso de apoderado no está activo.'), { statusCode: 403 });

  const [{ data: players, error: playerError }, { data: links, error: linkError }] = await Promise.all([
    supabase.from('jugadores').select('id,nombre,foto_url,avatar_url,tutor_id,apoderado_id,tutor_principal_id').eq('academia_id', academiaId),
    supabase.from('jugador_tutor').select('jugador_id').eq('tutor_id', tutor.id),
  ]);
  if (playerError) throw playerError;
  if (linkError) throw linkError;
  const linkedIds = new Set((links || []).map((item) => String(item.jugador_id)));
  const ownPlayers = (players || []).filter((player) => linkedIds.has(String(player.id))
    || [player.tutor_id, player.apoderado_id, player.tutor_principal_id].some((id) => String(id || '') === String(tutor.id)));
  return { academiaId, tutor, ownPlayers };
};

router.get('/', async (req, res) => {
  try {
    const { academiaId, tutor, ownPlayers } = await loadGuardianContext(req.user);
    const playerIds = ownPlayers.map((player) => player.id);
    const [enrollmentResult, sitesResult, branchesResult, categoriesResult, requestsResult] = await Promise.all([
      playerIds.length ? supabase.from('inscripciones_deportivas')
        .select('id,jugador_id,estado,fecha_inicio,monto_mensualidad,sede_id,rama_id,categoria_id,sedes(nombre),ramas(nombre,disciplina),categorias(nombre)')
        .eq('academia_id', academiaId).in('jugador_id', playerIds).eq('estado', 'Activa').order('created_at', { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      supabase.from('sedes').select('id,nombre,activa').eq('academia_id', academiaId).eq('activa', true).order('principal', { ascending: false }).order('nombre'),
      supabase.from('ramas').select('id,sede_id,nombre,disciplina,activa').eq('academia_id', academiaId).eq('activa', true).order('principal', { ascending: false }).order('nombre'),
      supabase.from('categorias').select('id,sede_id,rama_id,nombre').eq('academia_id', academiaId).order('nombre'),
      supabase.from('solicitudes_inscripcion_deportiva')
        .select('id,jugador_id,sede_id,rama_id,categoria_id,estado,mensaje,respuesta,monto_matricula,monto_mensualidad,created_at,resuelto_at,sedes(nombre),ramas(nombre,disciplina),categorias(nombre)')
        .eq('academia_id', academiaId).eq('tutor_id', tutor.id).order('created_at', { ascending: false }).limit(50),
    ]);
    for (const result of [enrollmentResult, sitesResult, branchesResult, categoriesResult, requestsResult]) if (result.error) throw result.error;

    const byPlayer = new Map();
    for (const enrollment of enrollmentResult.data || []) {
      const list = byPlayer.get(String(enrollment.jugador_id)) || [];
      list.push(enrollment); byPlayer.set(String(enrollment.jugador_id), list);
    }
    const jugadores = ownPlayers.map(({ tutor_id: _tutor, apoderado_id: _guardian, tutor_principal_id: _principal, ...player }) => ({
      ...player, inscripciones: byPlayer.get(String(player.id)) || [],
    }));
    const estructura = (sitesResult.data || []).map((site) => ({
      ...site,
      ramas: (branchesResult.data || []).filter((branch) => branch.sede_id === site.id).map((branch) => ({
        ...branch, categorias: (categoriesResult.data || []).filter((category) => category.rama_id === branch.id && category.sede_id === site.id),
      })),
    }));
    return res.json({ success: true, data: { jugadores, estructura, solicitudes: requestsResult.data || [] } });
  } catch (error) {
    console.error('Error cargando disciplinas del apoderado:', error?.message || error);
    return res.status(error?.statusCode || 500).json({ error: error?.statusCode ? error.message : 'No fue posible cargar las disciplinas de tus alumnos.' });
  }
});

router.get('/respuestas', async (req, res) => {
  try {
    const { academiaId, ownPlayers } = await loadGuardianContext(req.user);
    const playerIds = ownPlayers.map((player) => player.id);
    if (!playerIds.length) return res.json({ success: true, data: { participaciones: [], citaciones: [] } });
    const playerMap = new Map(ownPlayers.map((player) => [String(player.id), player]));
    const [participationResult, citationResult] = await Promise.all([
      supabase.from('torneo_participantes')
        .select('id,torneo_id,jugador_id,categoria_id,respuesta_participacion,pago_en_cuotas,numero_cuotas,paso_bot,estado_pago,canal_respuesta,canal_cuotas,created_at,torneos!inner(id,nombre,academia_id,fecha_inicio,fecha_fin,costo_inscripcion,permite_cuotas,max_cuotas,estado),categorias(id,nombre)')
        .eq('academia_id', academiaId).eq('torneos.academia_id', academiaId).in('jugador_id', playerIds)
        .order('created_at', { ascending: false }).limit(200),
      supabase.from('partido_citaciones')
        .select('id,partido_id,jugador_id,respuesta,motivo_ausencia,paso_bot,canal_respuesta,respuesta_actualizada_at,created_at,partidos!inner(id,academia_id,rival,fecha,hora,hora_citacion,ubicacion,categoria_id,categorias(nombre))')
        .eq('partidos.academia_id', academiaId).in('jugador_id', playerIds)
        .order('created_at', { ascending: false }).limit(200),
    ]);
    if (participationResult.error) throw participationResult.error;
    if (citationResult.error) throw citationResult.error;

    const groups = new Map();
    for (const row of participationResult.data || []) {
      const key = `${row.torneo_id}:${row.jugador_id}`;
      const current = groups.get(key) || {
        torneo_id: row.torneo_id,
        jugador_id: row.jugador_id,
        jugador: playerMap.get(String(row.jugador_id)) || null,
        torneo: row.torneos,
        categorias: [],
        respuesta_participacion: row.respuesta_participacion || 'Pendiente',
        pago_en_cuotas: Boolean(row.pago_en_cuotas),
        numero_cuotas: Math.max(1, Number(row.numero_cuotas) || 1),
        paso_bot: row.paso_bot || 'FINALIZADO',
        estado_pago: row.estado_pago || 'Pendiente',
        canal_respuesta: row.canal_respuesta || null,
        canal_cuotas: row.canal_cuotas || null,
      };
      if (row.categorias && !current.categorias.some((item) => String(item.id) === String(row.categorias.id))) current.categorias.push(row.categorias);
      if (row.respuesta_participacion === 'Si') current.respuesta_participacion = 'Si';
      else if (row.respuesta_participacion === 'No' && current.respuesta_participacion !== 'Si') current.respuesta_participacion = 'No';
      if (row.paso_bot === 'ESPERANDO_CUOTAS') current.paso_bot = 'ESPERANDO_CUOTAS';
      groups.set(key, current);
    }

    const today = new Date().toISOString().slice(0, 10);
    const citaciones = (citationResult.data || [])
      .filter((row) => String(row.partidos?.fecha || '') >= today)
      .map((row) => ({ ...row, jugador: playerMap.get(String(row.jugador_id)) || null, partido: row.partidos }));

    return res.json({ success: true, data: { participaciones: [...groups.values()], citaciones } });
  } catch (error) {
    console.error('Error cargando respuestas deportivas del apoderado:', error?.message || error);
    return res.status(error?.statusCode || 500).json({ error: error?.statusCode ? error.message : 'No fue posible cargar tus confirmaciones deportivas.' });
  }
});

router.patch('/respuestas/participacion/:torneoId/:jugadorId', async (req, res) => {
  try {
    const { academiaId, ownPlayers } = await loadGuardianContext(req.user);
    if (!ownPlayers.some((player) => String(player.id) === String(req.params.jugadorId))) return res.status(403).json({ error: 'Solo puedes responder por alumnos vinculados a tu cuenta.' });
    const data = await updateTournamentParticipation({
      academyId: academiaId,
      tournamentId: req.params.torneoId,
      playerId: req.params.jugadorId,
      response: req.body?.respuesta,
      installments: req.body?.cuotas,
      channel: 'portal_apoderado',
      actorUserId: req.user.id,
    });
    return res.json({ success: true, data, message: data.pending_installments ? 'Participación confirmada. Ahora selecciona la cantidad de cuotas.' : 'Respuesta registrada correctamente.' });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible registrar la participación.' });
  }
});

router.patch('/respuestas/citacion/:partidoId/:jugadorId', async (req, res) => {
  try {
    const { academiaId, ownPlayers } = await loadGuardianContext(req.user);
    if (!ownPlayers.some((player) => String(player.id) === String(req.params.jugadorId))) return res.status(403).json({ error: 'Solo puedes responder por alumnos vinculados a tu cuenta.' });
    const data = await updateCitation({
      academyId: academiaId,
      matchId: req.params.partidoId,
      playerId: req.params.jugadorId,
      response: req.body?.respuesta,
      reason: req.body?.motivo,
      channel: 'portal_apoderado',
      actorUserId: req.user.id,
    });
    return res.json({ success: true, data, message: data.respuesta === 'Si' ? 'Asistencia confirmada.' : 'Inasistencia registrada.' });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible responder la citación.' });
  }
});

router.post('/solicitudes', async (req, res) => {
  try {
    const { academiaId, tutor, ownPlayers } = await loadGuardianContext(req.user);
    const jugadorId = String(req.body?.jugador_id || '').trim();
    const sedeId = String(req.body?.sede_id || '').trim();
    const ramaId = String(req.body?.rama_id || '').trim();
    const categoriaId = String(req.body?.categoria_id || '').trim() || null;
    if (!jugadorId || !sedeId || !ramaId) return res.status(400).json({ error: 'Selecciona alumno, sede y disciplina.' });
    if (!ownPlayers.some((player) => String(player.id) === jugadorId)) return res.status(403).json({ error: 'Solo puedes solicitar una disciplina para tus alumnos vinculados.' });

    const [siteResult, branchResult, categoryResult, existingResult] = await Promise.all([
      supabase.from('sedes').select('id,activa').eq('id', sedeId).eq('academia_id', academiaId).maybeSingle(),
      supabase.from('ramas').select('id,sede_id,nombre,disciplina,activa').eq('id', ramaId).eq('academia_id', academiaId).maybeSingle(),
      categoriaId ? supabase.from('categorias').select('id,sede_id,rama_id').eq('id', categoriaId).eq('academia_id', academiaId).maybeSingle() : Promise.resolve({ data: null, error: null }),
      supabase.from('inscripciones_deportivas').select('id').eq('academia_id', academiaId).eq('jugador_id', jugadorId).eq('rama_id', ramaId).eq('estado', 'Activa').maybeSingle(),
    ]);
    for (const result of [siteResult, branchResult, categoryResult, existingResult]) if (result.error) throw result.error;
    if (!siteResult.data?.activa || !branchResult.data?.activa || branchResult.data.sede_id !== sedeId) return res.status(400).json({ error: 'La disciplina seleccionada no está disponible.' });
    if (categoriaId && (!categoryResult.data || categoryResult.data.sede_id !== sedeId || categoryResult.data.rama_id !== ramaId)) return res.status(400).json({ error: 'La categoría no corresponde a la disciplina seleccionada.' });
    if (existingResult.data) return res.status(409).json({ error: 'El alumno ya está inscrito en esa disciplina.', code: 'SPORT_ENROLLMENT_EXISTS' });

    const { data, error } = await supabase.from('solicitudes_inscripcion_deportiva').insert({
      academia_id: academiaId, tutor_id: tutor.id, jugador_id: jugadorId, sede_id: sedeId, rama_id: ramaId,
      categoria_id: categoriaId, mensaje: String(req.body?.mensaje || '').trim().slice(0, 1000) || null,
    }).select('id,estado,created_at').single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Ya existe una solicitud pendiente para esa disciplina.', code: 'SPORT_REQUEST_EXISTS' });
      throw error;
    }
    return res.status(201).json({ success: true, data, message: `Solicitud enviada para ${branchResult.data.disciplina || branchResult.data.nombre}. La academia definirá categoría y valores antes de aprobar.` });
  } catch (error) {
    console.error('Error creando solicitud deportiva:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible enviar la solicitud deportiva.' });
  }
});

module.exports = router;
