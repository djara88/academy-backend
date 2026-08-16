const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { requireFeature } = require('../middleware/planAccess');
const { FEATURES } = require('../services/planCatalog');
const { normalizePhone } = require('../services/chatWhatsApp');
const { crearGrupo, actualizarParticipantesGrupo, obtenerParticipantesGrupo, enviarMensajeGrupo } = require('../services/whatsappService');
const { academyMessage, getAcademyName } = require('../services/academyIdentity');

const router = express.Router();
router.use(authMiddleware, ...requireFeature(FEATURES.GUARDIANS), requireDirector);

const safeText = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const activePlayer = (player) => !player.privacy_anonymized_at && String(player.estado || '').toLowerCase() !== 'inactivo';

const resolveTargetTutors = async (academyId, scope, categoryId = null) => {
  const [{ data: tutors, error: tutorError }, { data: players, error: playerError }, { data: links, error: linkError }] = await Promise.all([
    supabase.from('tutores').select('id,nombre,nombre_completo,telefono').eq('academia_id', academyId),
    supabase.from('jugadores').select('id,categoria_id,tutor_id,apoderado_id,tutor_principal_id,estado,privacy_anonymized_at').eq('academia_id', academyId),
    supabase.from('jugador_tutor').select('jugador_id,tutor_id'),
  ]);
  if (tutorError) throw tutorError;
  if (playerError) throw playerError;
  if (linkError) throw linkError;

  const playerIdsByCategory = new Set();
  if (scope === 'categoria' && categoryId) {
    const directIds = (players || []).filter((player) => activePlayer(player) && String(player.categoria_id || '') === String(categoryId)).map((player) => player.id);
    directIds.forEach((id) => playerIdsByCategory.add(String(id)));
    const { data: categoryLinks, error: categoryError } = await supabase.from('jugador_categoria')
      .select('jugador_id').eq('categoria_id', categoryId);
    if (categoryError) throw categoryError;
    (categoryLinks || []).forEach((item) => playerIdsByCategory.add(String(item.jugador_id)));
  }

  const eligiblePlayers = (players || []).filter((player) => {
    if (!activePlayer(player)) return false;
    if (scope === 'global') return true;
    return playerIdsByCategory.has(String(player.id));
  });
  const eligiblePlayerIds = new Set(eligiblePlayers.map((player) => String(player.id)));
  const tutorIds = new Set();
  eligiblePlayers.forEach((player) => {
    [player.tutor_id, player.apoderado_id, player.tutor_principal_id].filter(Boolean).forEach((id) => tutorIds.add(String(id)));
  });
  (links || []).forEach((link) => {
    if (eligiblePlayerIds.has(String(link.jugador_id)) && link.tutor_id) tutorIds.add(String(link.tutor_id));
  });

  const uniquePhones = new Set();
  const targets = [];
  for (const tutor of tutors || []) {
    if (!tutorIds.has(String(tutor.id))) continue;
    const phone = normalizePhone(tutor.telefono);
    if (phone.length < 8 || uniquePhones.has(phone)) continue;
    uniquePhones.add(phone);
    targets.push({
      tutor_id: tutor.id,
      nombre: tutor.nombre_completo || tutor.nombre || 'Apoderado',
      telefono: phone,
    });
  }
  return targets;
};

router.get('/candidates', async (req, res) => {
  try {
    const { data: categories, error } = await supabase.from('categorias')
      .select('id,nombre').eq('academia_id', req.user.academia_id).order('nombre');
    if (error) throw error;
    const globalTargets = await resolveTargetTutors(req.user.academia_id, 'global');
    const categoryCounts = [];
    for (const category of categories || []) {
      const targets = await resolveTargetTutors(req.user.academia_id, 'categoria', category.id);
      categoryCounts.push({ ...category, apoderados_con_whatsapp: targets.length });
    }
    res.json({ success: true, global_count: globalTargets.length, categories: categoryCounts });
  } catch (error) {
    console.error('Error calculando candidatos de grupos WhatsApp:', error?.message || 'Error desconocido');
    res.status(500).json({ error: 'No fue posible calcular los apoderados disponibles.' });
  }
});

router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase.from('whatsapp_groups')
      .select('id,academia_id,categoria_id,scope,nombre,group_jid,estado,participantes_objetivo,participantes_agregados,last_error,created_at,updated_at,last_sync_at,categorias(id,nombre)')
      .eq('academia_id', req.user.academia_id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (error) {
    res.status(500).json({ error: 'No fue posible cargar los grupos de WhatsApp.' });
  }
});

router.post('/', async (req, res) => {
  const scope = String(req.body?.scope || '');
  const categoryId = req.body?.categoria_id ? String(req.body.categoria_id) : null;
  const name = safeText(req.body?.nombre, 100);
  const confirmed = req.body?.confirm_phone_visibility === true;
  if (!['global', 'categoria'].includes(scope)) return res.status(400).json({ error: 'Selecciona un alcance válido.' });
  if (scope === 'categoria' && !categoryId) return res.status(400).json({ error: 'Selecciona una categoría.' });
  if (!name) return res.status(400).json({ error: 'Escribe un nombre para el grupo.' });
  if (!confirmed) return res.status(400).json({ code: 'PHONE_VISIBILITY_CONFIRMATION_REQUIRED', error: 'Confirma que los participantes de un grupo real de WhatsApp podrán ver los números de otros miembros.' });

  let groupRow = null;
  try {
    if (categoryId) {
      const { data: category, error: categoryError } = await supabase.from('categorias')
        .select('id').eq('id', categoryId).eq('academia_id', req.user.academia_id).maybeSingle();
      if (categoryError) throw categoryError;
      if (!category) return res.status(404).json({ error: 'Categoría no encontrada.' });
    }

    const targets = await resolveTargetTutors(req.user.academia_id, scope, categoryId);
    if (!targets.length) return res.status(409).json({ error: 'No hay apoderados vinculados con teléfono válido para crear este grupo.' });

    const { data: inserted, error: insertError } = await supabase.from('whatsapp_groups').insert({
      academia_id: req.user.academia_id,
      categoria_id: scope === 'categoria' ? categoryId : null,
      scope,
      nombre: name,
      estado: 'creando',
      participantes_objetivo: targets.length,
      created_by: req.user.id,
    }).select().single();
    if (insertError) throw insertError;
    groupRow = inserted;

    const { error: memberError } = await supabase.from('whatsapp_group_members').insert(targets.map((target) => ({
      group_id: inserted.id,
      tutor_id: target.tutor_id,
      telefono: target.telefono,
      estado: 'objetivo',
    })));
    if (memberError) throw memberError;

    const result = await crearGrupo(req.user.academia_id, {
      subject: name,
      description: scope === 'global' ? 'Grupo general de apoderados de la academia administrado por Syncademia.' : 'Grupo de apoderados por categoría administrado por Syncademia.',
      participants: targets.map((target) => target.telefono),
    });
    if (!result.groupJid) throw new Error('WhatsApp creó el grupo pero no devolvió un identificador reconocible.');

    await Promise.all([
      supabase.from('whatsapp_groups').update({
        group_jid: result.groupJid,
        estado: 'activo',
        participantes_agregados: result.participants.length,
        last_sync_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_error: null,
      }).eq('id', inserted.id),
      supabase.from('whatsapp_group_members').update({ estado: 'agregado', updated_at: new Date().toISOString() }).eq('group_id', inserted.id),
    ]);

    res.status(201).json({ success: true, data: { ...inserted, group_jid: result.groupJid, estado: 'activo', participantes_agregados: result.participants.length } });
  } catch (error) {
    const message = safeText(error?.message || 'No fue posible crear el grupo.', 300);
    if (groupRow?.id) {
      await supabase.from('whatsapp_groups').update({ estado: 'error', last_error: message, updated_at: new Date().toISOString() }).eq('id', groupRow.id);
    }
    console.error('Error creando grupo WhatsApp:', message);
    res.status(500).json({ error: message });
  }
});

router.post('/:id/messages', async (req, res) => {
  const body = safeText(req.body?.body, 4000);
  if (!body) return res.status(400).json({ error: 'Escribe un mensaje.' });
  try {
    const { data: group, error } = await supabase.from('whatsapp_groups')
      .select('id,group_jid,estado,nombre').eq('id', req.params.id).eq('academia_id', req.user.academia_id).maybeSingle();
    if (error) throw error;
    if (!group) return res.status(404).json({ error: 'Grupo no encontrado.' });
    if (group.estado !== 'activo' || !group.group_jid) return res.status(409).json({ error: 'El grupo no está disponible para enviar mensajes.' });
    const academyName = await getAcademyName(req.user.academia_id);
    const result = await enviarMensajeGrupo(req.user.academia_id, group.group_jid, academyMessage(academyName, body));
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: safeText(error?.message || 'No fue posible enviar el mensaje al grupo.', 300) });
  }
});

router.post('/:id/sync', async (req, res) => {
  try {
    const { data: group, error } = await supabase.from('whatsapp_groups')
      .select('id,academia_id,categoria_id,scope,nombre,group_jid,estado').eq('id', req.params.id).eq('academia_id', req.user.academia_id).maybeSingle();
    if (error) throw error;
    if (!group) return res.status(404).json({ error: 'Grupo no encontrado.' });
    if (!group.group_jid || group.estado !== 'activo') return res.status(409).json({ error: 'El grupo no está activo.' });

    const targets = await resolveTargetTutors(req.user.academia_id, group.scope, group.categoria_id);
    const currentParticipants = await obtenerParticipantesGrupo(req.user.academia_id, group.group_jid);
    const currentPhones = new Set((currentParticipants || []).map((item) => normalizePhone(item.id || item.jid || item.phone)).filter(Boolean));
    const missing = targets.filter((target) => !currentPhones.has(target.telefono));
    if (missing.length) await actualizarParticipantesGrupo(req.user.academia_id, group.group_jid, 'add', missing.map((item) => item.telefono));

    const memberRows = targets.map((target) => ({ group_id: group.id, tutor_id: target.tutor_id, telefono: target.telefono, estado: 'agregado', updated_at: new Date().toISOString() }));
    if (memberRows.length) await supabase.from('whatsapp_group_members').upsert(memberRows, { onConflict: 'group_id,telefono' });
    await supabase.from('whatsapp_groups').update({
      participantes_objetivo: targets.length,
      participantes_agregados: Math.max(currentPhones.size + missing.length, targets.length),
      last_sync_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_error: null,
    }).eq('id', group.id);
    res.json({ success: true, added: missing.length, target_count: targets.length });
  } catch (error) {
    const message = safeText(error?.message || 'No fue posible sincronizar el grupo.', 300);
    await supabase.from('whatsapp_groups').update({ last_error: message, updated_at: new Date().toISOString() }).eq('id', req.params.id).eq('academia_id', req.user.academia_id);
    res.status(500).json({ error: message });
  }
});

module.exports = router;
