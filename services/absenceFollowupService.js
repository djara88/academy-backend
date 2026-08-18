const supabase = require('../config/supabase');
const { enviarMensaje } = require('./whatsappService');
const { academyMessage, getAcademyName } = require('./academyIdentity');
const { comparablePhone, extractMessageId } = require('./chatWhatsApp');

const safeText = (value, max = 5000) => String(value ?? '').trim().slice(0, max);
const uniqueIds = (values) => [...new Set((values || []).map((value) => String(value || '')).filter(Boolean))];
const normalizePhone = (value) => {
  let phone = String(value || '').replace(/\D/g, '');
  if (!phone.startsWith('56') && phone.length === 9) phone = `56${phone}`;
  return phone;
};

const getPlayerContacts = async (academyId, playerIds) => {
  if (!playerIds.length) return new Map();
  const { data: players, error: playerError } = await supabase.from('jugadores')
    .select('id,nombre,tutor_id,tutor_principal_id,apoderado_id,telefono_apoderado,nombre_apoderado')
    .eq('academia_id', academyId)
    .in('id', playerIds);
  if (playerError) throw playerError;

  const tutorIds = uniqueIds((players || []).map((player) => player.tutor_id || player.tutor_principal_id || player.apoderado_id));
  let tutors = [];
  if (tutorIds.length) {
    const result = await supabase.from('tutores')
      .select('id,nombre,nombre_completo,telefono,usuario_id')
      .eq('academia_id', academyId)
      .in('id', tutorIds);
    if (result.error) throw result.error;
    tutors = result.data || [];
  }
  const tutorMap = new Map(tutors.map((tutor) => [String(tutor.id), tutor]));
  return new Map((players || []).map((player) => {
    const tutorId = player.tutor_id || player.tutor_principal_id || player.apoderado_id || null;
    const tutor = tutorId ? tutorMap.get(String(tutorId)) || null : null;
    return [String(player.id), {
      player,
      tutor,
      tutorId,
      phone: normalizePhone(tutor?.telefono || player.telefono_apoderado),
      tutorName: tutor?.nombre_completo || tutor?.nombre || player.nombre_apoderado || 'Apoderado/a',
    }];
  }));
};

const getBranchLabel = async (academyId, branchId) => {
  if (!branchId) return 'Rama deportiva';
  const { data, error } = await supabase.from('ramas')
    .select('id,nombre,disciplina')
    .eq('academia_id', academyId)
    .eq('id', branchId)
    .maybeSingle();
  if (error) throw error;
  return data?.nombre || data?.disciplina || 'Rama deportiva';
};

const createAttendanceCase = async ({ academyId, professorId, category, training, player }) => {
  const formattedDate = new Date(`${training.fecha}T12:00:00`).toLocaleDateString('es-CL', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const { data, error } = await supabase.from('profesor_casos').insert({
    academia_id: academyId,
    profesor_id: professorId,
    creado_por: professorId,
    origen: 'profesor',
    categoria_id: category.id,
    rama_id: category.rama_id,
    jugador_id: player.id,
    tipo: 'asistencia',
    prioridad: 'normal',
    titulo: `Inasistencia · ${player.nombre}`.slice(0, 160),
    detalle: `Ausencia registrada el ${formattedDate} en ${category.nombre}. Lestra envió una consulta automática al apoderado para conocer el motivo.`,
    estado: 'abierto',
  }).select('id').single();
  if (error) throw error;
  return data.id;
};

const notifyProfessorAbsences = async ({ academyId, professorId, category, training, attendance }) => {
  const absent = (attendance || []).filter((item) => item?.estado === 'Ausente' && item?.jugador_id);
  const result = { solicitadas: absent.length, enviadas: 0, omitidas: 0, fallidas: 0, duplicadas: 0, casos_creados: 0 };
  if (!absent.length) return result;

  const contacts = await getPlayerContacts(academyId, uniqueIds(absent.map((item) => item.jugador_id)));
  const [academyName, branchLabel] = await Promise.all([
    getAcademyName(academyId),
    getBranchLabel(academyId, category.rama_id),
  ]);
  const formattedDate = new Date(`${training.fecha}T12:00:00`).toLocaleDateString('es-CL', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  for (const item of absent) {
    const contact = contacts.get(String(item.jugador_id));
    if (!contact) { result.omitidas += 1; continue; }
    const phone = contact.phone;
    const comparable = comparablePhone(phone);
    if (!phone || !comparable) { result.omitidas += 1; continue; }

    const existingResult = await supabase.from('asistencia_seguimientos_whatsapp')
      .select('id,caso_id,estado,enviado_at')
      .eq('academia_id', academyId)
      .eq('entrenamiento_id', training.id)
      .eq('jugador_id', item.jugador_id)
      .maybeSingle();
    if (existingResult.error) throw existingResult.error;
    let followup = existingResult.data || null;
    if (followup && followup.estado !== 'fallido') {
      result.duplicadas += 1;
      continue;
    }

    let caseId = followup?.caso_id || null;
    if (!caseId) {
      caseId = await createAttendanceCase({ academyId, professorId, category, training, player: contact.player });
      result.casos_creados += 1;
    }

    if (!followup) {
      const insertResult = await supabase.from('asistencia_seguimientos_whatsapp').insert({
        academia_id: academyId,
        entrenamiento_id: training.id,
        jugador_id: item.jugador_id,
        tutor_id: contact.tutorId,
        profesor_id: professorId,
        caso_id: caseId,
        telefono: phone,
        telefono_comparable: comparable,
        estado: 'pendiente',
      }).select('id,caso_id,estado,enviado_at').single();
      if (insertResult.error) {
        if (insertResult.error.code === '23505') {
          await supabase.from('profesor_casos').delete().eq('id', caseId).eq('academia_id', academyId);
          result.duplicadas += 1;
          continue;
        }
        throw insertResult.error;
      }
      followup = insertResult.data;
    } else {
      await supabase.from('asistencia_seguimientos_whatsapp').update({
        caso_id: caseId,
        tutor_id: contact.tutorId,
        profesor_id: professorId,
        telefono: phone,
        telefono_comparable: comparable,
        estado: 'pendiente',
        error_envio: null,
        updated_at: new Date().toISOString(),
      }).eq('id', followup.id);
    }

    const message = academyMessage(academyName,
      `💙 *SEGUIMIENTO DE ASISTENCIA*\n\n` +
      `Hola ${contact.tutorName},\n\n` +
      `hoy registramos a *${contact.player.nombre}* como ausente en el entrenamiento de *${category.nombre}*.\n\n` +
      `🏷️ *Rama:* ${branchLabel}\n` +
      `📅 *Fecha:* ${formattedDate}\n` +
      `⏰ *Hora:* ${training.hora || 'Sin horario informado'}\n\n` +
      `¿Podrías contarnos brevemente el motivo de la inasistencia? Responde a este mensaje con el motivo y quedará registrado para el profesor y la dirección. 🙌`);

    try {
      const sendResult = await enviarMensaje(academyId, phone, message);
      const externalId = extractMessageId(sendResult);
      await supabase.from('asistencia_seguimientos_whatsapp').update({
        estado: 'pendiente',
        enviado_at: new Date().toISOString(),
        whatsapp_message_id: externalId ? String(externalId).slice(0, 180) : null,
        error_envio: null,
        updated_at: new Date().toISOString(),
      }).eq('id', followup.id);
      result.enviadas += 1;
    } catch (error) {
      await supabase.from('asistencia_seguimientos_whatsapp').update({
        estado: 'fallido',
        error_envio: safeText(error?.message || 'No fue posible enviar el WhatsApp.', 500),
        updated_at: new Date().toISOString(),
      }).eq('id', followup.id);
      result.fallidas += 1;
      console.error(`No se pudo enviar seguimiento de inasistencia para ${item.jugador_id}:`, error?.message || error);
    }
  }
  return result;
};

const closeCorrectedAbsenceFollowups = async ({ academyId, professorId, trainingId, attendance }) => {
  const correctedIds = uniqueIds((attendance || []).filter((item) => item?.jugador_id && item.estado !== 'Ausente').map((item) => item.jugador_id));
  if (!correctedIds.length) return 0;
  const { data: pending, error } = await supabase.from('asistencia_seguimientos_whatsapp')
    .select('id,caso_id,jugador_id')
    .eq('academia_id', academyId)
    .eq('entrenamiento_id', trainingId)
    .eq('estado', 'pendiente')
    .in('jugador_id', correctedIds);
  if (error) throw error;
  const now = new Date().toISOString();
  for (const item of pending || []) {
    await supabase.from('asistencia_seguimientos_whatsapp').update({ estado: 'cancelado', updated_at: now }).eq('id', item.id);
    if (item.caso_id) {
      await supabase.from('profesor_caso_mensajes').insert({
        caso_id: item.caso_id,
        academia_id: academyId,
        autor_id: professorId,
        autor_rol: 'profesor',
        mensaje: 'La asistencia fue corregida posteriormente a Presente/Justificado. Lestra cerró el seguimiento automático de inasistencia.',
      });
      await supabase.from('profesor_casos').update({
        estado: 'resuelto',
        resuelto_por: professorId,
        resuelto_at: now,
        updated_at: now,
      }).eq('id', item.caso_id).eq('academia_id', academyId);
    }
  }
  return (pending || []).length;
};

const captureAbsenceReply = async ({ academyId, phone, body }) => {
  const text = safeText(body, 4000);
  const comparable = comparablePhone(phone);
  if (!academyId || !comparable || !text) return { handled: false };
  const since = new Date(Date.now() - (72 * 60 * 60 * 1000)).toISOString();
  const { data, error } = await supabase.from('asistencia_seguimientos_whatsapp')
    .select('id,caso_id,tutor_id,jugador_id,profesor_id,enviado_at')
    .eq('academia_id', academyId)
    .eq('telefono_comparable', comparable)
    .eq('estado', 'pendiente')
    .not('enviado_at', 'is', null)
    .gte('enviado_at', since)
    .order('enviado_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const followup = data?.[0];
  if (!followup?.caso_id) return { handled: false };

  let tutorUserId = null;
  if (followup.tutor_id) {
    const tutorResult = await supabase.from('tutores').select('usuario_id').eq('id', followup.tutor_id).eq('academia_id', academyId).maybeSingle();
    if (tutorResult.error) throw tutorResult.error;
    tutorUserId = tutorResult.data?.usuario_id || null;
  }

  const now = new Date().toISOString();
  const messageResult = await supabase.from('profesor_caso_mensajes').insert({
    caso_id: followup.caso_id,
    academia_id: academyId,
    autor_id: tutorUserId,
    autor_rol: 'apoderado',
    mensaje: text,
  }).select('id').single();
  if (messageResult.error) throw messageResult.error;

  const followupUpdate = await supabase.from('asistencia_seguimientos_whatsapp').update({
    estado: 'respondido',
    respondido_at: now,
    respuesta: text,
    updated_at: now,
  }).eq('id', followup.id);
  if (followupUpdate.error) throw followupUpdate.error;

  const caseUpdate = await supabase.from('profesor_casos').update({ estado: 'en_revision', updated_at: now })
    .eq('id', followup.caso_id).eq('academia_id', academyId);
  if (caseUpdate.error) throw caseUpdate.error;

  return { handled: true, followupId: followup.id, caseId: followup.caso_id, messageId: messageResult.data.id };
};

module.exports = {
  notifyProfessorAbsences,
  closeCorrectedAbsenceFollowups,
  captureAbsenceReply,
};