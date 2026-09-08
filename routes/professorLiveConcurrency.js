const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireProfessor } = require('../middleware/professorAccess');
const { publicProfile, resolveCompetitiveProfile } = require('../services/competitiveStatsCatalog');

const router = express.Router();

const cleanText = (value) => String(value || '').trim();
const cleanLimitedText = (value, maxLength) => cleanText(value).slice(0, maxLength);
const todayInChile = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const clampScore = (value, fallback = 0) => {
  if (value === undefined || value === null || value === '') return Math.max(0, Number(fallback) || 0);
  const number = Number(value);
  if (!Number.isFinite(number)) return Math.max(0, Number(fallback) || 0);
  return Math.min(9999, Math.max(0, Math.round(number)));
};

const requireAssignedMatch = async (user, matchId) => {
  const { data: match, error } = await supabase.from('partidos')
    .select('id,academia_id,categoria_id,rama_id,rival,fecha,hora,estado,goles_favor,goles_contra,disciplina_codigo,en_vivo,live_etapa,live_started_at,live_finished_at,live_updated_at,live_updated_by,categorias(id,nombre,rama_id),ramas(id,nombre,disciplina)')
    .eq('id', matchId).eq('academia_id', user.academia_id).maybeSingle();
  if (error) throw error;
  if (!match) throw Object.assign(new Error('Encuentro no encontrado.'), { status: 404 });
  if (!match.categoria_id || !match.rama_id) throw Object.assign(new Error('El encuentro no está correctamente vinculado a una rama y categoría.'), { status: 409 });

  const { data: assignment, error: assignmentError } = await supabase.from('profesor_categorias').select('id')
    .eq('academia_id', user.academia_id).eq('profesor_id', user.id)
    .eq('categoria_id', match.categoria_id).eq('activo', true).maybeSingle();
  if (assignmentError) throw assignmentError;
  if (!assignment) throw Object.assign(new Error('Esta categoría no está asignada a tu perfil.'), { status: 403 });
  if (String(match.categorias?.rama_id || '') !== String(match.rama_id)) throw Object.assign(new Error('La categoría del encuentro no coincide con su rama.'), { status: 409 });
  return match;
};

const logLiveEvent = async ({ user, matchId, action, detail = {} }) => {
  const { error } = await supabase.from('partido_live_eventos').insert({
    academia_id: user.academia_id,
    partido_id: matchId,
    profesor_id: user.id,
    jugador_id: null,
    accion: action,
    detalle: detail,
  });
  if (error) console.error('No se pudo registrar evento en vivo V2:', error.message);
};

const readCurrentMatch = async (academyId, matchId) => {
  const { data, error } = await supabase.from('partidos')
    .select('id,estado,en_vivo,goles_favor,goles_contra,live_etapa,live_started_at,live_finished_at,live_updated_at,live_updated_by')
    .eq('id', matchId).eq('academia_id', academyId).maybeSingle();
  if (error) throw error;
  return data;
};

const conflictPayload = async (user, matchId, message = 'El encuentro cambió en otro dispositivo. Sincroniza antes de continuar.') => ({
  success: false,
  code: 'LIVE_STATE_CONFLICT',
  error: message,
  data: await readCurrentMatch(user.academia_id, matchId),
});

// API V2: compatible con clientes nuevos sin alterar el contrato histórico.
// El inicio es idempotente y evita registrar dos inicios por doble click/dispositivo.
router.post('/me/partidos/:partidoId/en-vivo-v2/iniciar', authMiddleware, requireProfessor, async (req, res) => {
  try {
    const match = await requireAssignedMatch(req.user, req.params.partidoId);
    if (match.estado === 'Jugado' && !match.en_vivo) return res.status(409).json({ error: 'El encuentro ya está finalizado.', code: 'LIVE_ALREADY_FINISHED' });
    if (match.estado === 'Cancelado') return res.status(409).json({ error: 'El encuentro está cancelado.' });
    if (match.en_vivo) return res.json({ success: true, idempotent: true, message: 'El encuentro ya estaba activo.', data: match });
    if (match.fecha !== todayInChile()) return res.status(409).json({ error: 'El modo en vivo solo puede iniciarse el día del encuentro.' });

    const now = new Date().toISOString();
    const stage = cleanLimitedText(req.body?.etapa, 60) || match.live_etapa || 'En juego';
    const { data, error } = await supabase.from('partidos').update({
      en_vivo: true,
      estado: 'En vivo',
      live_etapa: stage,
      live_started_at: match.live_started_at || now,
      live_updated_at: now,
      live_updated_by: req.user.id,
      live_finished_at: null,
    })
      .eq('id', match.id).eq('academia_id', req.user.academia_id).eq('en_vivo', false)
      .select('*').maybeSingle();
    if (error) throw error;

    if (!data) {
      const current = await readCurrentMatch(req.user.academia_id, match.id);
      if (current?.en_vivo) return res.json({ success: true, idempotent: true, message: 'El encuentro ya fue iniciado desde otra sesión.', data: current });
      return res.status(409).json(await conflictPayload(req.user, match.id));
    }

    await logLiveEvent({ user: req.user, matchId: match.id, action: 'inicio', detail: { etapa: stage, score: [Number(match.goles_favor) || 0, Number(match.goles_contra) || 0] } });
    return res.json({ success: true, idempotent: false, message: 'Encuentro iniciado en vivo.', data });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible iniciar el encuentro.' });
  }
});

// Marcador y etapa usan optimistic concurrency sobre live_updated_at. La
// condición se repite en el UPDATE para que dos escrituras simultáneas con la
// misma versión no puedan ganar ambas.
router.patch('/me/partidos/:partidoId/en-vivo-v2', authMiddleware, requireProfessor, async (req, res) => {
  try {
    const expectedVersion = cleanText(req.body?.expected_live_updated_at);
    if (!expectedVersion) return res.status(428).json({ error: 'Sincroniza el encuentro antes de modificarlo.', code: 'LIVE_VERSION_REQUIRED' });

    const match = await requireAssignedMatch(req.user, req.params.partidoId);
    if (!match.en_vivo || match.estado === 'Jugado') return res.status(409).json({ error: 'El encuentro no está activo en modo en vivo.' });
    if (String(match.live_updated_at || '') !== expectedVersion) return res.status(409).json(await conflictPayload(req.user, match.id));

    const profile = resolveCompetitiveProfile({ discipline: match.ramas?.disciplina, code: match.disciplina_codigo });
    const stageProvided = req.body?.etapa !== undefined;
    const stage = stageProvided ? cleanLimitedText(req.body.etapa, 60) : match.live_etapa;
    const favor = profile.usesHeadToHeadScore ? clampScore(req.body?.resultado_favor, match.goles_favor) : Number(match.goles_favor) || 0;
    const contra = profile.usesHeadToHeadScore ? clampScore(req.body?.resultado_contra, match.goles_contra) : Number(match.goles_contra) || 0;
    const now = new Date().toISOString();

    const { data, error } = await supabase.from('partidos').update({
      ...(profile.usesHeadToHeadScore ? { goles_favor: favor, goles_contra: contra } : {}),
      ...(stageProvided ? { live_etapa: stage } : {}),
      live_updated_at: now,
      live_updated_by: req.user.id,
    })
      .eq('id', match.id).eq('academia_id', req.user.academia_id).eq('live_updated_at', expectedVersion)
      .select('*').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json(await conflictPayload(req.user, match.id));

    const scoreChanged = favor !== (Number(match.goles_favor) || 0) || contra !== (Number(match.goles_contra) || 0);
    if (scoreChanged) await logLiveEvent({ user: req.user, matchId: match.id, action: 'marcador', detail: { favor, contra, etiqueta: profile.scoreLabel } });
    if (stageProvided && stage !== match.live_etapa) await logLiveEvent({ user: req.user, matchId: match.id, action: 'etapa', detail: { etapa: stage } });
    return res.json({ success: true, data, sport_profile: publicProfile(profile) });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible actualizar el encuentro en vivo.' });
  }
});

// Finalizar también exige la versión que el profesor confirmó. Si la respuesta
// anterior se perdió pero el partido ya está Jugado, la repetición es segura.
router.post('/me/partidos/:partidoId/en-vivo-v2/finalizar', authMiddleware, requireProfessor, async (req, res) => {
  try {
    const expectedVersion = cleanText(req.body?.expected_live_updated_at);
    if (!expectedVersion) return res.status(428).json({ error: 'Sincroniza el encuentro antes de finalizarlo.', code: 'LIVE_VERSION_REQUIRED' });

    const match = await requireAssignedMatch(req.user, req.params.partidoId);
    if (!match.en_vivo && match.estado === 'Jugado') return res.json({ success: true, idempotent: true, message: 'El encuentro ya estaba finalizado.', data: match });
    if (!match.en_vivo) return res.status(409).json({ error: 'El encuentro no está activo en modo en vivo.' });
    if (String(match.live_updated_at || '') !== expectedVersion) return res.status(409).json(await conflictPayload(req.user, match.id, 'El encuentro cambió después de tu última sincronización. Revisa el marcador antes de finalizar.'));

    const profile = resolveCompetitiveProfile({ discipline: match.ramas?.disciplina, code: match.disciplina_codigo });
    const now = new Date().toISOString();
    const { data, error } = await supabase.from('partidos').update({
      en_vivo: false,
      estado: 'Jugado',
      live_etapa: cleanLimitedText(req.body?.etapa, 60) || 'Finalizado',
      live_finished_at: now,
      live_updated_at: now,
      live_updated_by: req.user.id,
    })
      .eq('id', match.id).eq('academia_id', req.user.academia_id).eq('live_updated_at', expectedVersion).eq('en_vivo', true)
      .select('*').maybeSingle();
    if (error) throw error;

    if (!data) {
      const current = await readCurrentMatch(req.user.academia_id, match.id);
      if (current?.estado === 'Jugado' && !current.en_vivo) return res.json({ success: true, idempotent: true, message: 'El encuentro ya fue finalizado desde otra sesión.', data: current });
      return res.status(409).json(await conflictPayload(req.user, match.id, 'El encuentro cambió antes de finalizar. Sincroniza y confirma nuevamente.'));
    }

    await logLiveEvent({ user: req.user, matchId: match.id, action: 'fin', detail: { favor: Number(data.goles_favor) || 0, contra: Number(data.goles_contra) || 0, etiqueta: profile.scoreLabel } });
    return res.json({ success: true, idempotent: false, message: 'Encuentro finalizado. El resultado queda disponible para revisión de dirección.', data });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible finalizar el encuentro.' });
  }
});

module.exports = router;
