const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { isDirector, isGuardian, requireDirector } = require('../middleware/professorAccess');
const { requireFeature } = require('../middleware/planAccess');
const { FEATURES } = require('../services/planCatalog');

const router = express.Router();
const guardianFeature = requireFeature(FEATURES.GUARDIANS);
const safeText = (value, max = 4000) => String(value ?? '').trim().slice(0, max);

router.use(authMiddleware, ...guardianFeature);

const getGuardianTutor = async (user) => {
  if (!isGuardian(user)) return null;
  const { data, error } = await supabase.from('tutores')
    .select('id,usuario_id,nombre_completo,nombre,email,acceso_activo')
    .eq('academia_id', user.academia_id)
    .eq('usuario_id', user.id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
};

const getConversation = async (conversationId, user) => {
  const { data, error } = await supabase.from('chat_conversations')
    .select('id,academia_id,tutor_id,jugador_id,asunto,estado,last_message_at,created_at,updated_at,tutores(id,nombre,nombre_completo,email),jugadores(id,nombre)')
    .eq('id', conversationId)
    .eq('academia_id', user.academia_id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (isDirector(user)) return data;
  if (!isGuardian(user)) return null;
  const { data: participant, error: participantError } = await supabase.from('chat_participants')
    .select('conversation_id')
    .eq('conversation_id', data.id)
    .eq('user_id', user.id)
    .eq('active', true)
    .maybeSingle();
  if (participantError) throw participantError;
  return participant ? data : null;
};

const ensureParticipant = async (conversationId, user) => {
  const role = isGuardian(user) ? 'apoderado' : 'director';
  const { error } = await supabase.from('chat_participants').upsert({
    conversation_id: conversationId,
    user_id: user.id,
    participant_role: role,
    active: true,
  }, { onConflict: 'conversation_id,user_id', ignoreDuplicates: true });
  if (error) throw error;
};

const linkedPlayerToTutor = async (academyId, playerId, tutorId) => {
  const { data: player, error: playerError } = await supabase.from('jugadores')
    .select('id,tutor_id,apoderado_id,tutor_principal_id')
    .eq('id', playerId).eq('academia_id', academyId).maybeSingle();
  if (playerError) throw playerError;
  if (!player) return false;
  if ([player.tutor_id, player.apoderado_id, player.tutor_principal_id].some((id) => String(id || '') === String(tutorId))) return true;
  const { data: link, error: linkError } = await supabase.from('jugador_tutor')
    .select('jugador_id').eq('jugador_id', playerId).eq('tutor_id', tutorId).maybeSingle();
  if (linkError) throw linkError;
  return Boolean(link);
};

router.get('/contacts', requireDirector, async (req, res) => {
  try {
    const { data: tutors, error } = await supabase.from('tutores')
      .select('id,nombre,nombre_completo,email,telefono,usuario_id,acceso_activo')
      .eq('academia_id', req.user.academia_id)
      .order('nombre_completo');
    if (error) throw error;
    const tutorIds = (tutors || []).map((item) => item.id);
    const [{ data: players, error: playerError }, { data: links, error: linkError }] = await Promise.all([
      supabase.from('jugadores').select('id,nombre,tutor_id,apoderado_id,tutor_principal_id').eq('academia_id', req.user.academia_id),
      tutorIds.length ? supabase.from('jugador_tutor').select('jugador_id,tutor_id').in('tutor_id', tutorIds) : Promise.resolve({ data: [], error: null }),
    ]);
    if (playerError) throw playerError;
    if (linkError) throw linkError;
    const data = (tutors || []).map((tutor) => ({
      ...tutor,
      can_chat: Boolean(tutor.usuario_id && tutor.acceso_activo !== false),
      jugadores: (players || []).filter((player) =>
        [player.tutor_id, player.apoderado_id, player.tutor_principal_id].some((id) => String(id || '') === String(tutor.id))
        || (links || []).some((link) => String(link.tutor_id) === String(tutor.id) && String(link.jugador_id) === String(player.id))
      ).map((player) => ({ id: player.id, nombre: player.nombre })),
    }));
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error cargando contactos del chat:', error?.message || 'Error desconocido');
    res.status(500).json({ error: 'No fue posible cargar los contactos.' });
  }
});

router.get('/conversations', async (req, res) => {
  try {
    const director = isDirector(req.user);
    const guardian = isGuardian(req.user);
    if (!director && !guardian) return res.status(403).json({ error: 'Perfil no habilitado para comunicaciones.' });

    let rows = [];
    if (director) {
      const { data, error } = await supabase.from('chat_conversations')
        .select('id,academia_id,tutor_id,jugador_id,asunto,estado,last_message_at,created_at,updated_at,tutores(id,nombre,nombre_completo,email),jugadores(id,nombre)')
        .eq('academia_id', req.user.academia_id)
        .order('last_message_at', { ascending: false, nullsFirst: false });
      if (error) throw error;
      rows = data || [];
      if (rows.length) {
        const participantRows = rows.map((row) => ({ conversation_id: row.id, user_id: req.user.id, participant_role: 'director', active: true }));
        const { error: upsertError } = await supabase.from('chat_participants').upsert(participantRows, { onConflict: 'conversation_id,user_id', ignoreDuplicates: true });
        if (upsertError) throw upsertError;
      }
    } else {
      const tutor = await getGuardianTutor(req.user);
      if (!tutor) return res.json({ success: true, data: [] });
      const { data: participants, error: participantError } = await supabase.from('chat_participants')
        .select('conversation_id').eq('user_id', req.user.id).eq('active', true);
      if (participantError) throw participantError;
      const ids = (participants || []).map((item) => item.conversation_id);
      if (ids.length) {
        const { data, error } = await supabase.from('chat_conversations')
          .select('id,academia_id,tutor_id,jugador_id,asunto,estado,last_message_at,created_at,updated_at,tutores(id,nombre,nombre_completo,email),jugadores(id,nombre)')
          .eq('academia_id', req.user.academia_id).in('id', ids)
          .order('last_message_at', { ascending: false, nullsFirst: false });
        if (error) throw error;
        rows = data || [];
      }
    }

    const ids = rows.map((row) => row.id);
    const [{ data: reads, error: readError }, { data: messages, error: messageError }] = await Promise.all([
      ids.length ? supabase.from('chat_participants').select('conversation_id,last_read_at').eq('user_id', req.user.id).in('conversation_id', ids) : Promise.resolve({ data: [], error: null }),
      ids.length ? supabase.from('chat_messages').select('id,conversation_id,sender_user_id,sender_role,body,created_at,deleted_at').in('conversation_id', ids).is('deleted_at', null).order('created_at', { ascending: false }).limit(2000) : Promise.resolve({ data: [], error: null }),
    ]);
    if (readError) throw readError;
    if (messageError) throw messageError;
    const readMap = new Map((reads || []).map((item) => [String(item.conversation_id), item.last_read_at]));
    const messagesByConversation = new Map();
    (messages || []).forEach((message) => {
      const key = String(message.conversation_id);
      if (!messagesByConversation.has(key)) messagesByConversation.set(key, []);
      messagesByConversation.get(key).push(message);
    });
    const data = rows.map((row) => {
      const convoMessages = messagesByConversation.get(String(row.id)) || [];
      const lastRead = readMap.get(String(row.id));
      const unread = convoMessages.filter((message) => String(message.sender_user_id || '') !== String(req.user.id)
        && (!lastRead || new Date(message.created_at) > new Date(lastRead))).length;
      return { ...row, unread_count: unread, last_message: convoMessages[0] || null };
    });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error cargando conversaciones:', error?.message || 'Error desconocido');
    res.status(500).json({ error: 'No fue posible cargar las conversaciones.' });
  }
});

router.post('/conversations', requireDirector, async (req, res) => {
  try {
    const tutorId = String(req.body?.tutor_id || '');
    const playerId = req.body?.jugador_id ? String(req.body.jugador_id) : null;
    const asunto = safeText(req.body?.asunto, 180) || 'Conversación con la familia';
    if (!tutorId) return res.status(400).json({ error: 'Selecciona un apoderado.' });
    const { data: tutor, error: tutorError } = await supabase.from('tutores')
      .select('id,nombre,nombre_completo,usuario_id,acceso_activo')
      .eq('id', tutorId).eq('academia_id', req.user.academia_id).maybeSingle();
    if (tutorError) throw tutorError;
    if (!tutor) return res.status(404).json({ error: 'Apoderado no encontrado.' });
    if (!tutor.usuario_id || tutor.acceso_activo === false) {
      return res.status(409).json({ error: 'Primero activa el acceso al portal de este apoderado para poder conversar.' });
    }
    if (playerId && !await linkedPlayerToTutor(req.user.academia_id, playerId, tutor.id)) {
      return res.status(400).json({ error: 'El alumno seleccionado no está vinculado a este apoderado.' });
    }

    let existingQuery = supabase.from('chat_conversations')
      .select('*').eq('academia_id', req.user.academia_id).eq('tutor_id', tutor.id).eq('estado', 'activa');
    existingQuery = playerId ? existingQuery.eq('jugador_id', playerId) : existingQuery.is('jugador_id', null);
    const { data: existing, error: existingError } = await existingQuery.maybeSingle();
    if (existingError) throw existingError;
    let conversation = existing;
    if (!conversation) {
      const { data, error } = await supabase.from('chat_conversations').insert({
        academia_id: req.user.academia_id,
        tutor_id: tutor.id,
        jugador_id: playerId,
        asunto,
        created_by: req.user.id,
      }).select().single();
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'Ya existe una conversación activa con esta familia y alumno.' });
        throw error;
      }
      conversation = data;
    }
    const participants = [
      { conversation_id: conversation.id, user_id: req.user.id, participant_role: 'director', active: true, last_read_at: new Date().toISOString() },
      { conversation_id: conversation.id, user_id: tutor.usuario_id, participant_role: 'apoderado', active: true },
    ];
    const { error: participantError } = await supabase.from('chat_participants').upsert(participants, { onConflict: 'conversation_id,user_id' });
    if (participantError) throw participantError;
    res.status(existing ? 200 : 201).json({ success: true, data: conversation, already_exists: Boolean(existing) });
  } catch (error) {
    console.error('Error creando conversación:', error?.message || 'Error desconocido');
    res.status(500).json({ error: 'No fue posible crear la conversación.' });
  }
});

router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const conversation = await getConversation(req.params.id, req.user);
    if (!conversation) return res.status(404).json({ error: 'Conversación no encontrada.' });
    await ensureParticipant(conversation.id, req.user);
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 20), 200);
    let query = supabase.from('chat_messages')
      .select('id,conversation_id,sender_user_id,sender_role,body,created_at,edited_at,deleted_at')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (req.query.before) query = query.lt('created_at', String(req.query.before));
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, data: (data || []).reverse(), conversation });
  } catch (error) {
    console.error('Error cargando mensajes:', error?.message || 'Error desconocido');
    res.status(500).json({ error: 'No fue posible cargar los mensajes.' });
  }
});

router.post('/conversations/:id/messages', async (req, res) => {
  try {
    const body = safeText(req.body?.body, 4000);
    if (!body) return res.status(400).json({ error: 'Escribe un mensaje.' });
    const conversation = await getConversation(req.params.id, req.user);
    if (!conversation) return res.status(404).json({ error: 'Conversación no encontrada.' });
    if (conversation.estado !== 'activa') return res.status(409).json({ error: 'Esta conversación está cerrada.' });
    await ensureParticipant(conversation.id, req.user);
    const senderRole = isGuardian(req.user) ? 'apoderado' : 'director';
    const { data, error } = await supabase.from('chat_messages').insert({
      conversation_id: conversation.id,
      academia_id: req.user.academia_id,
      sender_user_id: req.user.id,
      sender_role: senderRole,
      body,
    }).select('id,conversation_id,sender_user_id,sender_role,body,created_at').single();
    if (error) throw error;
    await supabase.from('chat_participants').update({ last_read_at: data.created_at, active: true })
      .eq('conversation_id', conversation.id).eq('user_id', req.user.id);
    res.status(201).json({ success: true, data });
  } catch (error) {
    console.error('Error enviando mensaje:', error?.message || 'Error desconocido');
    res.status(500).json({ error: 'No fue posible enviar el mensaje.' });
  }
});

router.patch('/conversations/:id/read', async (req, res) => {
  try {
    const conversation = await getConversation(req.params.id, req.user);
    if (!conversation) return res.status(404).json({ error: 'Conversación no encontrada.' });
    await ensureParticipant(conversation.id, req.user);
    const { error } = await supabase.from('chat_participants').update({ last_read_at: new Date().toISOString(), active: true })
      .eq('conversation_id', conversation.id).eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'No fue posible actualizar el estado de lectura.' });
  }
});

router.patch('/conversations/:id/close', requireDirector, async (req, res) => {
  try {
    const conversation = await getConversation(req.params.id, req.user);
    if (!conversation) return res.status(404).json({ error: 'Conversación no encontrada.' });
    const { error } = await supabase.from('chat_conversations').update({ estado: 'cerrada', updated_at: new Date().toISOString() })
      .eq('id', conversation.id).eq('academia_id', req.user.academia_id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'No fue posible cerrar la conversación.' });
  }
});

module.exports = router;
