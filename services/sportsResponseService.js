const supabase = require('../config/supabase');

const cleanChannel = (value) => String(value || 'aplicacion').trim().slice(0, 40);
const cleanReason = (value) => String(value || '').trim().slice(0, 500) || null;

const normalizeResponse = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (['si', 'sí', 'confirmado', 'confirmar', 'aceptar', 'aceptado'].includes(normalized)) return 'Si';
  if (['no', 'rechazado', 'rechazar', 'declinar'].includes(normalized)) return 'No';
  return null;
};

const updateTournamentParticipation = async ({ academyId, tournamentId, playerId, response, installments, channel, actorUserId }) => {
  const decision = normalizeResponse(response);
  if (!decision) throw Object.assign(new Error('Selecciona Confirmar o No participa.'), { status: 400 });

  const { data: tournament, error: tournamentError } = await supabase.from('torneos')
    .select('id,nombre,academia_id,costo_inscripcion,permite_cuotas,max_cuotas')
    .eq('id', tournamentId).eq('academia_id', academyId).maybeSingle();
  if (tournamentError) throw tournamentError;
  if (!tournament) throw Object.assign(new Error('Competencia no encontrada.'), { status: 404 });

  const { data: rows, error: rowsError } = await supabase.from('torneo_participantes')
    .select('id,categoria_id,respuesta_participacion,pago_en_cuotas,numero_cuotas,paso_bot')
    .eq('academia_id', academyId).eq('torneo_id', tournamentId).eq('jugador_id', playerId)
    .order('created_at', { ascending: true });
  if (rowsError) throw rowsError;
  if (!rows?.length) throw Object.assign(new Error('El alumno no está convocado a esta competencia.'), { status: 404 });

  const now = new Date().toISOString();
  const responseAudit = {
    canal_respuesta: cleanChannel(channel),
    respuesta_actualizada_at: now,
    respuesta_actualizada_por: actorUserId || null,
  };

  if (decision === 'No') {
    const { error } = await supabase.from('torneo_participantes').update({
      respuesta_participacion: 'No',
      pago_en_cuotas: false,
      numero_cuotas: 1,
      paso_bot: 'FINALIZADO',
      ...responseAudit,
    }).eq('academia_id', academyId).eq('torneo_id', tournamentId).eq('jugador_id', playerId);
    if (error) throw error;
    return { tournament, response: 'No', installments: 1, pending_installments: false };
  }

  const price = Math.max(0, Number(tournament.costo_inscripcion) || 0);
  const allowsInstallments = tournament.permite_cuotas === true && price > 0;
  const maxInstallments = Math.max(1, Number(tournament.max_cuotas) || 1);
  const requestedInstallments = installments === undefined || installments === null || installments === '' ? null : Number(installments);

  if (allowsInstallments && requestedInstallments !== null) {
    if (!Number.isInteger(requestedInstallments) || requestedInstallments < 1 || requestedInstallments > maxInstallments) {
      throw Object.assign(new Error(`Selecciona entre 1 y ${maxInstallments} cuotas.`), { status: 400 });
    }
    const { error } = await supabase.from('torneo_participantes').update({
      respuesta_participacion: 'Si',
      pago_en_cuotas: requestedInstallments > 1,
      numero_cuotas: requestedInstallments,
      paso_bot: 'FINALIZADO',
      ...responseAudit,
      canal_cuotas: cleanChannel(channel),
      cuotas_actualizadas_at: now,
      cuotas_actualizadas_por: actorUserId || null,
    }).eq('academia_id', academyId).eq('torneo_id', tournamentId).eq('jugador_id', playerId);
    if (error) throw error;
    return { tournament, response: 'Si', installments: requestedInstallments, pending_installments: false };
  }

  if (allowsInstallments) {
    const { error: groupError } = await supabase.from('torneo_participantes').update({
      respuesta_participacion: 'Si',
      paso_bot: 'FINALIZADO',
      ...responseAudit,
    }).eq('academia_id', academyId).eq('torneo_id', tournamentId).eq('jugador_id', playerId);
    if (groupError) throw groupError;
    const { error: primaryError } = await supabase.from('torneo_participantes').update({ paso_bot: 'ESPERANDO_CUOTAS' }).eq('id', rows[0].id);
    if (primaryError) throw primaryError;
    return { tournament, response: 'Si', installments: null, pending_installments: true, max_installments: maxInstallments };
  }

  const { error } = await supabase.from('torneo_participantes').update({
    respuesta_participacion: 'Si',
    pago_en_cuotas: false,
    numero_cuotas: 1,
    paso_bot: 'FINALIZADO',
    ...responseAudit,
  }).eq('academia_id', academyId).eq('torneo_id', tournamentId).eq('jugador_id', playerId);
  if (error) throw error;
  return { tournament, response: 'Si', installments: 1, pending_installments: false };
};

const updateCitation = async ({ academyId, matchId, playerId, response, reason, channel, actorUserId }) => {
  const decision = normalizeResponse(response);
  if (!decision) throw Object.assign(new Error('Selecciona Confirmar asistencia o No asistirá.'), { status: 400 });

  const { data: citation, error: citationError } = await supabase.from('partido_citaciones')
    .select('id,partido_id,jugador_id,respuesta,motivo_ausencia,partidos!inner(id,academia_id,rival,fecha,hora,hora_citacion)')
    .eq('partido_id', matchId).eq('jugador_id', playerId).eq('partidos.academia_id', academyId).maybeSingle();
  if (citationError) throw citationError;
  if (!citation) throw Object.assign(new Error('No existe una citación para este alumno en el evento.'), { status: 404 });

  const now = new Date().toISOString();
  const payload = {
    respuesta: decision,
    motivo_ausencia: decision === 'No' ? (cleanReason(reason) || 'No informado') : null,
    paso_bot: 'FINALIZADO',
    canal_respuesta: cleanChannel(channel),
    respuesta_actualizada_at: now,
    respuesta_actualizada_por: actorUserId || null,
  };
  const { data, error } = await supabase.from('partido_citaciones').update(payload)
    .eq('id', citation.id).eq('partido_id', matchId).eq('jugador_id', playerId)
    .select('id,partido_id,jugador_id,respuesta,motivo_ausencia,paso_bot,canal_respuesta,respuesta_actualizada_at').single();
  if (error) throw error;
  return { ...data, match: citation.partidos };
};

module.exports = { normalizeResponse, updateTournamentParticipation, updateCitation };
