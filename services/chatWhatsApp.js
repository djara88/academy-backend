const supabase = require('../config/supabase');
const { enviarMensaje } = require('./whatsappService');
const { academyMessage, getAcademyName } = require('./academyIdentity');

const normalizePhone = (value) => String(value || '').replace(/\D/g, '');
const comparablePhone = (value) => normalizePhone(value).slice(-8);
const safeText = (value, max = 4000) => String(value ?? '').trim().slice(0, max);

const extractMessageId = (payload) => {
  const candidates = [
    payload?.key?.id,
    payload?.data?.key?.id,
    payload?.message?.key?.id,
    payload?.id,
    payload?.messageId,
  ];
  return candidates.map((value) => String(value || '').trim()).find(Boolean) || null;
};

const findTutorByPhone = async (academyId, phone) => {
  const match = comparablePhone(phone);
  if (!match) return { tutor: null, ambiguous: false };
  const { data, error } = await supabase.from('tutores')
    .select('id,academia_id,nombre,nombre_completo,telefono,usuario_id,acceso_activo')
    .eq('academia_id', academyId)
    .not('telefono', 'is', null);
  if (error) throw error;
  const matches = (data || []).filter((item) => comparablePhone(item.telefono) === match);
  return { tutor: matches.length === 1 ? matches[0] : null, ambiguous: matches.length > 1 };
};

const ensureConversationParticipants = async (conversation, tutor) => {
  const participantRows = [];
  const { data: directors, error: directorError } = await supabase.from('usuarios')
    .select('id').eq('academia_id', conversation.academia_id).eq('rol', 'director').eq('activo', true);
  if (directorError) throw directorError;
  for (const director of directors || []) {
    participantRows.push({ conversation_id: conversation.id, user_id: director.id, participant_role: 'director', active: true });
  }
  if (tutor?.usuario_id && tutor.acceso_activo !== false) {
    participantRows.push({ conversation_id: conversation.id, user_id: tutor.usuario_id, participant_role: 'apoderado', active: true });
  }
  if (!participantRows.length) return;
  const { error } = await supabase.from('chat_participants').upsert(participantRows, {
    onConflict: 'conversation_id,user_id',
    ignoreDuplicates: true,
  });
  if (error) throw error;
};

const getOrCreateInboundConversation = async (academyId, tutor) => {
  const { data: active, error: activeError } = await supabase.from('chat_conversations')
    .select('*')
    .eq('academia_id', academyId)
    .eq('tutor_id', tutor.id)
    .eq('estado', 'activa')
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(10);
  if (activeError) throw activeError;
  let conversation = (active || []).find((item) => !item.jugador_id) || (active || [])[0] || null;
  if (!conversation) {
    const { data, error } = await supabase.from('chat_conversations').insert({
      academia_id: academyId,
      tutor_id: tutor.id,
      jugador_id: null,
      asunto: 'WhatsApp · Conversación con la familia',
      created_by: null,
    }).select().single();
    if (error) {
      if (error.code === '23505') {
        const { data: retry, error: retryError } = await supabase.from('chat_conversations')
          .select('*').eq('academia_id', academyId).eq('tutor_id', tutor.id).eq('estado', 'activa')
          .is('jugador_id', null).maybeSingle();
        if (retryError) throw retryError;
        conversation = retry;
      } else {
        throw error;
      }
    } else {
      conversation = data;
    }
  }
  if (conversation) await ensureConversationParticipants(conversation, tutor);
  return conversation;
};

const ingestInboundWhatsApp = async ({ academyId, phone, body, externalMessageId = null }) => {
  const text = safeText(body, 4000);
  if (!academyId || !text) return { stored: false, reason: 'invalid' };
  const { tutor, ambiguous } = await findTutorByPhone(academyId, phone);
  if (ambiguous) return { stored: false, reason: 'ambiguous_phone' };
  if (!tutor) return { stored: false, reason: 'tutor_not_found' };
  const conversation = await getOrCreateInboundConversation(academyId, tutor);
  if (!conversation) return { stored: false, reason: 'conversation_not_found' };

  const messageId = externalMessageId ? String(externalMessageId).slice(0, 180) : null;
  const { data, error } = await supabase.from('chat_messages').insert({
    conversation_id: conversation.id,
    academia_id: academyId,
    sender_user_id: tutor.usuario_id || null,
    sender_role: 'apoderado',
    body: text,
    origin_channel: 'whatsapp',
    whatsapp_status: 'received',
    whatsapp_message_id: messageId,
    whatsapp_updated_at: new Date().toISOString(),
  }).select('id,conversation_id,created_at').single();
  if (error) {
    if (error.code === '23505' && messageId) return { stored: true, duplicate: true, conversationId: conversation.id };
    throw error;
  }
  return { stored: true, conversationId: conversation.id, messageId: data.id };
};

const sendDirectorMessageToWhatsApp = async ({ academyId, tutorId, body, chatMessageId }) => {
  const { data: tutor, error: tutorError } = await supabase.from('tutores')
    .select('id,telefono,nombre,nombre_completo').eq('id', tutorId).eq('academia_id', academyId).maybeSingle();
  if (tutorError) throw tutorError;
  const phone = normalizePhone(tutor?.telefono);
  if (!phone) return { attempted: false, status: null };

  await supabase.from('chat_messages').update({
    whatsapp_status: 'pending', whatsapp_error: null, whatsapp_updated_at: new Date().toISOString(),
  }).eq('id', chatMessageId).eq('academia_id', academyId);

  try {
    const academyName = await getAcademyName(academyId);
    const result = await enviarMensaje(academyId, phone, academyMessage(academyName, body));
    const externalId = extractMessageId(result);
    const update = {
      whatsapp_status: 'sent',
      whatsapp_error: null,
      whatsapp_updated_at: new Date().toISOString(),
    };
    if (externalId) update.whatsapp_message_id = externalId.slice(0, 180);
    await supabase.from('chat_messages').update(update).eq('id', chatMessageId).eq('academia_id', academyId);
    return { attempted: true, status: 'sent', externalId };
  } catch (error) {
    const safeError = safeText(error?.message || 'No fue posible enviar por WhatsApp.', 300);
    await supabase.from('chat_messages').update({
      whatsapp_status: 'failed',
      whatsapp_error: safeError,
      whatsapp_updated_at: new Date().toISOString(),
    }).eq('id', chatMessageId).eq('academia_id', academyId);
    return { attempted: true, status: 'failed', error: safeError };
  }
};

const normalizeDeliveryStatus = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw.includes('read') || raw === '4') return 'read';
  if (raw.includes('deliver') || raw === '3') return 'delivered';
  if (raw.includes('sent') || raw === '2' || raw === 'server_ack') return 'sent';
  if (raw.includes('error') || raw.includes('fail')) return 'failed';
  return null;
};

const updateWhatsAppDelivery = async ({ externalMessageId, status }) => {
  const externalId = String(externalMessageId || '').trim();
  const normalized = normalizeDeliveryStatus(status);
  if (!externalId || !normalized) return { updated: false };
  const { data, error } = await supabase.from('chat_messages').update({
    whatsapp_status: normalized,
    whatsapp_updated_at: new Date().toISOString(),
  }).eq('whatsapp_message_id', externalId).select('id').maybeSingle();
  if (error) throw error;
  return { updated: Boolean(data), status: normalized };
};

module.exports = {
  normalizePhone,
  comparablePhone,
  extractMessageId,
  findTutorByPhone,
  ingestInboundWhatsApp,
  sendDirectorMessageToWhatsApp,
  updateWhatsAppDelivery,
};
