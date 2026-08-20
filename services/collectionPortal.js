const crypto = require('crypto');
const supabase = require('../config/supabase');

const secret = () => process.env.COLLECTION_PORTAL_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
const digest = (value) => crypto.createHmac('sha256', secret()).update(String(value || '')).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

const createPortalToken = async ({ academyId, tutorId = null, playerId = null, via = 'sistema', userId = null, ttlMinutes = 30 }) => {
  if (!tutorId && !playerId) throw new Error('El token de cobranza necesita un apoderado o alumno.');
  const token = randomToken();
  const expiresAt = new Date(Date.now() + Math.max(5, Number(ttlMinutes) || 30) * 60000).toISOString();
  const { data, error } = await supabase.from('cobranza_portal_tokens').insert({
    academia_id: academyId,
    tutor_id: tutorId,
    jugador_id: playerId,
    token_hash: digest(token),
    alcance: 'pago_informado',
    expira_at: expiresAt,
    creado_via: String(via || 'sistema').slice(0, 50),
    creado_por: userId || null,
  }).select('id,expira_at').single();
  if (error) throw error;
  return { token, tokenId: data.id, expiresAt: data.expira_at };
};

const loadPortalToken = async (token) => {
  if (!token || String(token).length < 30) return null;
  const { data, error } = await supabase.from('cobranza_portal_tokens')
    .select('id,academia_id,tutor_id,jugador_id,alcance,expira_at,revocado_at')
    .eq('token_hash', digest(token)).maybeSingle();
  if (error) throw error;
  if (!data || data.revocado_at || new Date(data.expira_at).getTime() <= Date.now()) return null;
  await supabase.from('cobranza_portal_tokens').update({ ultimo_uso_at: new Date().toISOString() }).eq('id', data.id);
  return data;
};

const linkedPlayersForTutor = async (academyId, tutorId) => {
  const [{ data: players, error: playerError }, { data: links, error: linkError }] = await Promise.all([
    supabase.from('jugadores')
      .select('id,nombre,rut,tutor_id,apoderado_id,tutor_principal_id,estado_financiero')
      .eq('academia_id', academyId),
    supabase.from('jugador_tutor').select('jugador_id').eq('tutor_id', tutorId),
  ]);
  if (playerError) throw playerError;
  if (linkError) throw linkError;
  const linkedIds = new Set((links || []).map((row) => String(row.jugador_id)));
  return (players || []).filter((player) => linkedIds.has(String(player.id)) ||
    [player.tutor_id, player.apoderado_id, player.tutor_principal_id].some((id) => String(id || '') === String(tutorId)));
};

const authorizedPlayersForToken = async (tokenRow) => {
  if (tokenRow.jugador_id) {
    const { data, error } = await supabase.from('jugadores')
      .select('id,nombre,rut,estado_financiero,tutor_id,apoderado_id,tutor_principal_id')
      .eq('id', tokenRow.jugador_id).eq('academia_id', tokenRow.academia_id).maybeSingle();
    if (error) throw error;
    return data ? [data] : [];
  }
  if (tokenRow.tutor_id) return linkedPlayersForTutor(tokenRow.academia_id, tokenRow.tutor_id);
  return [];
};

const normalizePhone = (value) => {
  let phone = String(value || '').replace(/\D/g, '');
  if (!phone.startsWith('56') && phone.length === 9) phone = `56${phone}`;
  return phone;
};

module.exports = { digest, createPortalToken, loadPortalToken, linkedPlayersForTutor, authorizedPlayersForToken, normalizePhone };