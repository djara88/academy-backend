const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { recordPrivacyEvent, revokeImageConsent, anonymizePlayer, buildPrivacyExport } = require('../services/privacyExecution');

const router = express.Router();
router.use(authMiddleware, requireDirector);

const TYPES = new Set(['acceso', 'rectificacion', 'supresion', 'oposicion', 'portabilidad', 'bloqueo', 'revocacion_imagen']);
const TERMINAL = new Set(['ejecutada', 'cerrada', 'rechazada']);
const safeText = (value, max = 5000) => String(value ?? '').trim().slice(0, max);
const activeDeadline = (row) => row.fecha_limite_prorrogada || row.fecha_limite;

const loadRequest = async (academyId, id) => {
  const { data, error } = await supabase.from('solicitudes_privacidad').select('*')
    .eq('academia_id', academyId).eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
};

router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase.from('solicitudes_privacidad')
      .select('*,jugadores(id,nombre,rut,privacy_anonymized_at),tutores(id,nombre_completo,email)')
      .eq('academia_id', req.user.academia_id)
      .order('fecha_recepcion', { ascending: false })
      .limit(300);
    if (error) throw error;

    const now = Date.now();
    const rows = (data || []).map((row) => {
      const deadline = activeDeadline(row);
      const remainingDays = deadline ? Math.ceil((new Date(deadline).getTime() - now) / 86400000) : null;
      return { ...row, dias_restantes: remainingDays };
    });
    const open = rows.filter((row) => !TERMINAL.has(row.estado));
    res.json({
      success: true,
      data: rows,
      summary: {
        total: rows.length,
        abiertas: open.length,
        vencidas: open.filter((row) => Number(row.dias_restantes) < 0).length,
        proximas_vencer: open.filter((row) => Number(row.dias_restantes) >= 0 && Number(row.dias_restantes) <= 5).length,
        pendientes_identidad: open.filter((row) => !row.identidad_verificada).length,
      },
    });
  } catch (error) {
    console.error('Error cargando solicitudes de privacidad:', error?.message || 'Error desconocido');
    res.status(500).json({ error: 'No fue posible cargar las solicitudes de privacidad.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const tipo = safeText(req.body?.tipo, 40).toLowerCase();
    if (!TYPES.has(tipo)) return res.status(400).json({ error: 'Tipo de solicitud no válido.' });
    const playerId = safeText(req.body?.jugador_id, 80);
    if (!playerId) return res.status(400).json({ error: 'Selecciona el alumno asociado a la solicitud.' });

    const { data: player, error: playerError } = await supabase.from('jugadores')
      .select('id,nombre,tutor_id,apoderado_id,tutor_principal_id')
      .eq('academia_id', req.user.academia_id).eq('id', playerId).maybeSingle();
    if (playerError || !player) return res.status(404).json({ error: 'Alumno no encontrado.' });

    const tutorId = safeText(req.body?.tutor_id, 80) || player.tutor_id || player.apoderado_id || player.tutor_principal_id || null;
    let tutor = null;
    if (tutorId) {
      const { data } = await supabase.from('tutores').select('id,nombre_completo,nombre,rut,email')
        .eq('academia_id', req.user.academia_id).eq('id', tutorId).maybeSingle();
      tutor = data || null;
    }

    const requesterName = safeText(req.body?.solicitante_nombre || tutor?.nombre_completo || tutor?.nombre, 180);
    const requesterEmail = safeText(req.body?.solicitante_email || tutor?.email, 240).toLowerCase();
    if (!requesterName || !/^\S+@\S+\.\S+$/.test(requesterEmail)) {
      return res.status(400).json({ error: 'Nombre y correo válido del solicitante son obligatorios.' });
    }
    const blockRequested = req.body?.bloqueo_solicitado === true && ['rectificacion', 'supresion', 'oposicion', 'bloqueo'].includes(tipo);
    const now = new Date();
    const deadline = new Date(now.getTime() + 30 * 86400000).toISOString();
    const { data: created, error } = await supabase.from('solicitudes_privacidad').insert({
      academia_id: req.user.academia_id,
      jugador_id: player.id,
      tutor_id: tutorId,
      tipo,
      estado: 'verificacion_pendiente',
      canal: safeText(req.body?.canal, 30) || 'director',
      solicitante_nombre: requesterName,
      solicitante_documento: safeText(req.body?.solicitante_documento || tutor?.rut, 80) || null,
      solicitante_email: requesterEmail,
      detalle: safeText(req.body?.detalle, 5000) || null,
      cambios_solicitados: req.body?.cambios_solicitados && typeof req.body.cambios_solicitados === 'object' ? req.body.cambios_solicitados : {},
      bloqueo_solicitado: blockRequested,
      fecha_recepcion: now.toISOString(),
      fecha_limite: deadline,
      created_by: req.user.id,
    }).select('*').single();
    if (error) throw error;

    await recordPrivacyEvent({
      requestId: created.id,
      academyId: req.user.academia_id,
      event: 'solicitud_registrada',
      actorUserId: req.user.id,
      detail: { tipo, canal: created.canal, jugador_id: player.id },
    });
    res.status(201).json({ success: true, data: created });
  } catch (error) {
    console.error('Error registrando solicitud de privacidad:', error?.message || 'Error desconocido');
    res.status(500).json({ error: 'No fue posible registrar la solicitud.' });
  }
});

router.patch('/:id/verificar-identidad', async (req, res) => {
  try {
    const row = await loadRequest(req.user.academia_id, req.params.id);
    if (!row) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    if (TERMINAL.has(row.estado)) return res.status(409).json({ error: 'La solicitud ya está cerrada.' });
    const now = new Date().toISOString();
    const { data, error } = await supabase.from('solicitudes_privacidad').update({
      identidad_verificada: true,
      identidad_verificada_at: now,
      identidad_verificada_por: req.user.id,
      estado: 'en_revision',
      updated_at: now,
    }).eq('id', row.id).eq('academia_id', req.user.academia_id).select('*').single();
    if (error) throw error;
    await recordPrivacyEvent({ requestId: row.id, academyId: req.user.academia_id, event: 'identidad_verificada', actorUserId: req.user.id });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: 'No fue posible verificar la identidad.' });
  }
});

router.patch('/:id/prorrogar', async (req, res) => {
  try {
    const row = await loadRequest(req.user.academia_id, req.params.id);
    if (!row) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    if (TERMINAL.has(row.estado)) return res.status(409).json({ error: 'La solicitud ya está cerrada.' });
    if (row.fecha_limite_prorrogada) return res.status(409).json({ error: 'La solicitud ya utilizó su única prórroga.' });
    const base = new Date(row.fecha_limite).getTime();
    const extended = new Date(base + 30 * 86400000).toISOString();
    const { data, error } = await supabase.from('solicitudes_privacidad').update({
      fecha_limite_prorrogada: extended,
      updated_at: new Date().toISOString(),
    }).eq('id', row.id).eq('academia_id', req.user.academia_id).select('*').single();
    if (error) throw error;
    await recordPrivacyEvent({ requestId: row.id, academyId: req.user.academia_id, event: 'plazo_prorrogado', actorUserId: req.user.id, detail: { hasta: extended } });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: 'No fue posible prorrogar el plazo.' });
  }
});

router.patch('/:id/decision', async (req, res) => {
  try {
    const row = await loadRequest(req.user.academia_id, req.params.id);
    if (!row) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    if (TERMINAL.has(row.estado)) return res.status(409).json({ error: 'La solicitud ya está cerrada.' });
    if (!row.identidad_verificada) return res.status(409).json({ error: 'Verifica primero la identidad del solicitante.' });
    const decision = safeText(req.body?.decision, 20).toLowerCase();
    if (!['aprobada', 'rechazada'].includes(decision)) return res.status(400).json({ error: 'Decisión no válida.' });
    const responseText = safeText(req.body?.respuesta, 6000);
    const reason = safeText(req.body?.fundamento, 6000);
    if (!responseText || (decision === 'rechazada' && !reason)) {
      return res.status(400).json({ error: 'Registra la respuesta y, si rechazas, el fundamento de la decisión.' });
    }
    const now = new Date().toISOString();
    const { data, error } = await supabase.from('solicitudes_privacidad').update({
      estado: decision,
      respuesta: responseText,
      fundamento_decision: reason || null,
      fecha_resolucion: now,
      updated_at: now,
    }).eq('id', row.id).eq('academia_id', req.user.academia_id).select('*').single();
    if (error) throw error;
    await recordPrivacyEvent({ requestId: row.id, academyId: req.user.academia_id, event: `decision_${decision}`, actorUserId: req.user.id, detail: { tiene_fundamento: Boolean(reason) } });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: 'No fue posible registrar la decisión.' });
  }
});

router.get('/:id/export', async (req, res) => {
  try {
    const row = await loadRequest(req.user.academia_id, req.params.id);
    if (!row || !row.jugador_id) return res.status(404).json({ error: 'Solicitud o alumno no disponible.' });
    if (!row.identidad_verificada) return res.status(409).json({ error: 'Verifica primero la identidad del solicitante.' });
    const data = await buildPrivacyExport({ academyId: req.user.academia_id, playerId: row.jugador_id });
    await recordPrivacyEvent({ requestId: row.id, academyId: req.user.academia_id, event: 'exportacion_generada', actorUserId: req.user.id });
    res.json({ success: true, request: { id: row.id, tipo: row.tipo }, data });
  } catch (error) {
    console.error('Error generando exportación de privacidad:', error?.message || 'Error desconocido');
    res.status(500).json({ error: 'No fue posible generar la exportación.' });
  }
});

router.post('/:id/ejecutar', async (req, res) => {
  try {
    const row = await loadRequest(req.user.academia_id, req.params.id);
    if (!row) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    if (row.estado === 'ejecutada' || row.estado === 'cerrada') return res.status(409).json({ error: 'La solicitud ya fue ejecutada.' });
    if (row.estado !== 'aprobada' || !row.identidad_verificada) {
      return res.status(409).json({ error: 'La solicitud debe estar aprobada y con identidad verificada.' });
    }
    if (!row.jugador_id) return res.status(409).json({ error: 'El alumno ya no está disponible para ejecutar esta solicitud.' });

    let summary = { ejecucion_manual: true, tipo: row.tipo };
    if (row.tipo === 'revocacion_imagen') {
      summary = await revokeImageConsent({ academyId: req.user.academia_id, playerId: row.jugador_id, requestId: row.id, actorUserId: req.user.id });
    } else if (row.tipo === 'supresion') {
      if (safeText(req.body?.confirmacion, 80).toUpperCase() !== 'SUPRIMIR DATOS') {
        return res.status(400).json({ error: 'Para ejecutar una supresión escribe exactamente SUPRIMIR DATOS.' });
      }
      summary = await anonymizePlayer({ academyId: req.user.academia_id, playerId: row.jugador_id, requestId: row.id, actorUserId: req.user.id });
    } else if (row.tipo === 'bloqueo' || row.bloqueo_solicitado) {
      const now = new Date().toISOString();
      const { error } = await supabase.from('jugadores').update({ privacy_blocked_at: now })
        .eq('academia_id', req.user.academia_id).eq('id', row.jugador_id);
      if (error) throw error;
      summary = { bloqueo_tratamiento_registrado: true, fecha: now, requiere_revision_operativa: true };
      await recordPrivacyEvent({ requestId: row.id, academyId: req.user.academia_id, event: 'bloqueo_registrado', actorUserId: req.user.id, detail: summary });
    }

    const now = new Date().toISOString();
    const { data, error } = await supabase.from('solicitudes_privacidad').update({
      estado: 'ejecutada',
      fecha_ejecucion: now,
      resumen_ejecucion: summary,
      updated_at: now,
    }).eq('id', row.id).eq('academia_id', req.user.academia_id).select('*').single();
    if (error) throw error;
    await recordPrivacyEvent({ requestId: row.id, academyId: req.user.academia_id, event: 'solicitud_ejecutada', actorUserId: req.user.id, detail: summary });
    res.json({ success: true, data, summary });
  } catch (error) {
    console.error('Error ejecutando solicitud de privacidad:', error?.message || 'Error desconocido');
    res.status(500).json({ error: 'No fue posible ejecutar la solicitud de privacidad.' });
  }
});

router.get('/:id/eventos', async (req, res) => {
  try {
    const row = await loadRequest(req.user.academia_id, req.params.id);
    if (!row) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    const { data, error } = await supabase.from('solicitudes_privacidad_eventos').select('*')
      .eq('academia_id', req.user.academia_id).eq('solicitud_id', row.id).order('created_at');
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (error) {
    res.status(500).json({ error: 'No fue posible cargar el historial.' });
  }
});

module.exports = router;
