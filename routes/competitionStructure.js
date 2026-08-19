const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { getTournament, getCategoryContext, safeText } = require('../services/branchContext');
const { generateCompetitionPreview } = require('../services/competitionStructurePreview');

const router = express.Router();
router.use(authMiddleware);

const allowedTypes = new Set(['equipo', 'deportista', 'pareja']);
const allowedOrigins = new Set(['academia', 'externo']);

const requireOrganized = (tournament) => {
  if (tournament?.tipo_gestion !== 'organizado') {
    throw Object.assign(new Error('Los competidores y la estructura interna solo se administran en competencias organizadas por la academia.'), { status: 409, code: 'EXTERNAL_COMPETITION_STRUCTURE' });
  }
};

const loadDivision = async (academyId, tournamentId, divisionId) => {
  const { data, error } = await supabase.from('torneo_divisiones')
    .select('id,torneo_id,categoria_id,nombre,modalidad,formato_competencia,orden,config,activa')
    .eq('id', divisionId)
    .eq('academia_id', academyId)
    .eq('torneo_id', tournamentId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('La división no pertenece a esta competencia.'), { status: 404, code: 'DIVISION_NOT_FOUND' });
  return data;
};

const resolveAcademyCompetitor = async ({ academyId, tournament, division, type, playerId, categoryId, suppliedName }) => {
  if (type === 'deportista') {
    if (!playerId) throw Object.assign(new Error('Selecciona el deportista de la academia.'), { status: 400, code: 'PLAYER_REQUIRED' });
    const { data: player, error: playerError } = await supabase.from('jugadores')
      .select('id,nombre')
      .eq('id', playerId)
      .eq('academia_id', academyId)
      .maybeSingle();
    if (playerError) throw playerError;
    if (!player) throw Object.assign(new Error('El deportista no pertenece a la academia.'), { status: 404, code: 'PLAYER_NOT_FOUND' });

    let enrollmentQuery = supabase.from('inscripciones_deportivas')
      .select('id,categoria_id,rama_id')
      .eq('academia_id', academyId)
      .eq('jugador_id', player.id)
      .eq('rama_id', tournament.rama_id)
      .eq('estado', 'Activa');
    if (division.categoria_id) enrollmentQuery = enrollmentQuery.eq('categoria_id', division.categoria_id);
    const { data: enrollments, error: enrollmentError } = await enrollmentQuery.limit(1);
    if (enrollmentError) throw enrollmentError;
    if (!enrollments?.length) {
      throw Object.assign(new Error('El deportista no tiene inscripción activa en la rama/categoría de esta división.'), { status: 409, code: 'PLAYER_NOT_ELIGIBLE_FOR_DIVISION' });
    }
    return { name: safeText(suppliedName, 180) || player.nombre, playerId: player.id, categoryId: division.categoria_id || enrollments[0].categoria_id || null };
  }

  if (type === 'equipo') {
    const resolvedCategoryId = categoryId || division.categoria_id || null;
    if (!resolvedCategoryId) {
      if (!safeText(suppliedName, 180)) throw Object.assign(new Error('Vincula una categoría o escribe el nombre del equipo de la academia.'), { status: 400, code: 'ACADEMY_TEAM_NAME_REQUIRED' });
      return { name: safeText(suppliedName, 180), playerId: null, categoryId: null };
    }
    const { category } = await getCategoryContext(academyId, resolvedCategoryId);
    if (String(category.rama_id) !== String(tournament.rama_id)) {
      throw Object.assign(new Error('La categoría del equipo pertenece a otra rama deportiva.'), { status: 409, code: 'COMPETITOR_CATEGORY_BRANCH_MISMATCH' });
    }
    if (division.categoria_id && String(division.categoria_id) !== String(category.id)) {
      throw Object.assign(new Error('La categoría no corresponde a la división seleccionada.'), { status: 409, code: 'COMPETITOR_DIVISION_CATEGORY_MISMATCH' });
    }
    return { name: safeText(suppliedName, 180) || category.nombre, playerId: null, categoryId: category.id };
  }

  const name = safeText(suppliedName, 180);
  if (!name) throw Object.assign(new Error('Ingresa el nombre de la pareja de la academia.'), { status: 400, code: 'PAIR_NAME_REQUIRED' });
  return { name, playerId: null, categoryId: division.categoria_id || categoryId || null };
};

router.get('/:id/competidores', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const tournament = await getTournament(academyId, req.params.id);
    requireOrganized(tournament);
    const divisionId = safeText(req.query?.division_id, 80);
    let query = supabase.from('torneo_competidores')
      .select('id,division_id,tipo,origen,nombre,jugador_id,categoria_id,seed,estado,metadata,created_at')
      .eq('academia_id', academyId)
      .eq('torneo_id', tournament.id)
      .order('seed', { ascending: true, nullsFirst: false })
      .order('created_at');
    if (divisionId) query = query.eq('division_id', divisionId);
    const { data, error } = await query;
    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible cargar los competidores.', code: error?.code });
  }
});

router.post('/:id/competidores', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const tournament = await getTournament(academyId, req.params.id);
    requireOrganized(tournament);
    const divisionId = safeText(req.body?.division_id, 80);
    if (!divisionId) return res.status(400).json({ success: false, error: 'Selecciona la división del competidor.' });
    const division = await loadDivision(academyId, tournament.id, divisionId);
    const type = safeText(req.body?.tipo, 30) || 'equipo';
    const origin = safeText(req.body?.origen, 30) || 'externo';
    if (!allowedTypes.has(type)) return res.status(400).json({ success: false, error: 'Tipo de competidor inválido.' });
    if (!allowedOrigins.has(origin)) return res.status(400).json({ success: false, error: 'Origen de competidor inválido.' });

    let name = safeText(req.body?.nombre, 180);
    let playerId = safeText(req.body?.jugador_id, 80) || null;
    let categoryId = safeText(req.body?.categoria_id, 80) || null;
    if (origin === 'academia') {
      const resolved = await resolveAcademyCompetitor({
        academyId,
        tournament,
        division,
        type,
        playerId,
        categoryId,
        suppliedName: name,
      });
      name = resolved.name;
      playerId = resolved.playerId;
      categoryId = resolved.categoryId;
    } else if (!name) {
      return res.status(400).json({ success: false, error: 'Ingresa el nombre del competidor externo.' });
    }

    const rawSeed = Number(req.body?.seed);
    const seed = Number.isFinite(rawSeed) && rawSeed > 0 ? Math.min(9999, Math.round(rawSeed)) : null;
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object' && !Array.isArray(req.body.metadata) ? req.body.metadata : {};
    const { data, error } = await supabase.from('torneo_competidores').insert({
      academia_id: academyId,
      torneo_id: tournament.id,
      division_id: division.id,
      tipo: type,
      origen: origin,
      nombre: name,
      jugador_id: playerId,
      categoria_id: categoryId,
      seed,
      estado: 'Activo',
      metadata,
    }).select('id,division_id,tipo,origen,nombre,jugador_id,categoria_id,seed,estado,metadata,created_at').single();
    if (error?.code === '23505') return res.status(409).json({ success: false, error: `“${name}” ya está registrado en esta división.`, code: 'DUPLICATE_COMPETITOR' });
    if (error) throw error;
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible agregar el competidor.', code: error?.code });
  }
});

router.delete('/:id/competidores/:competitorId', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const tournament = await getTournament(academyId, req.params.id);
    requireOrganized(tournament);
    const { data: linkedMatches, error: linkedError } = await supabase.from('partidos')
      .select('id')
      .eq('academia_id', academyId)
      .eq('torneo_id', tournament.id)
      .or(`competidor_a_id.eq.${req.params.competitorId},competidor_b_id.eq.${req.params.competitorId}`)
      .limit(1);
    if (linkedError) throw linkedError;
    if (linkedMatches?.length) {
      return res.status(409).json({ success: false, error: 'Este competidor ya está vinculado a un encuentro publicado y no puede eliminarse.', code: 'COMPETITOR_HAS_MATCHES' });
    }
    const { error } = await supabase.from('torneo_competidores')
      .delete()
      .eq('id', req.params.competitorId)
      .eq('academia_id', academyId)
      .eq('torneo_id', tournament.id);
    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible eliminar el competidor.', code: error?.code });
  }
});

router.get('/:id/preview', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const tournament = await getTournament(academyId, req.params.id);
    requireOrganized(tournament);
    const divisionId = safeText(req.query?.division_id, 80);
    if (!divisionId) return res.status(400).json({ success: false, error: 'Selecciona una división para previsualizar.' });
    const division = await loadDivision(academyId, tournament.id, divisionId);
    const [{ data: phases, error: phaseError }, { data: competitors, error: competitorError }] = await Promise.all([
      supabase.from('torneo_fases').select('id,nombre,tipo,orden,estado,config').eq('academia_id', academyId).eq('torneo_id', tournament.id).eq('division_id', division.id).order('orden'),
      supabase.from('torneo_competidores').select('id,nombre,tipo,origen,seed,estado,metadata').eq('academia_id', academyId).eq('torneo_id', tournament.id).eq('division_id', division.id).eq('estado', 'Activo').order('seed', { ascending: true, nullsFirst: false }).order('created_at'),
    ]);
    if (phaseError) throw phaseError;
    if (competitorError) throw competitorError;
    const preview = generateCompetitionPreview({ tournament, division, phases: phases || [], competitors: competitors || [] });
    return res.json({ success: true, data: { division, preview } });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible generar la vista previa.', code: error?.code });
  }
});

module.exports = router;
