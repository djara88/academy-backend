const crypto = require('crypto');
const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector, requireGuardian } = require('../middleware/professorAccess');
const { requireFeature } = require('../middleware/planAccess');
const { FEATURES } = require('../services/planCatalog');
const { sendGuardianAccessEmail } = require('../services/accessEmail');

const router = express.Router();
const guardianFeature = requireFeature(FEATURES.GUARDIANS);
const uniqueIds = (values) => [...new Set((values || []).map(String).filter(Boolean))];
const temporaryPassword = () => `${crypto.randomBytes(9).toString('base64url')}A9!`;

const getTutorPlayers = async (academyId, tutorId) => {
  const [{ data: direct, error: directError }, { data: links, error: linkError }] = await Promise.all([
    supabase.from('jugadores')
      .select('id,nombre,categoria_id,fecha_nacimiento,foto_url,avatar_url,estado_financiero,saldo_pendiente,tutor_id,apoderado_id,tutor_principal_id')
      .eq('academia_id', academyId),
    supabase.from('jugador_tutor').select('jugador_id').eq('tutor_id', tutorId),
  ]);
  if (directError) throw directError;
  if (linkError) throw linkError;
  const linkedIds = new Set((links || []).map((item) => String(item.jugador_id)));
  return (direct || []).filter((player) => linkedIds.has(String(player.id))
    || [player.tutor_id, player.apoderado_id, player.tutor_principal_id].some((id) => String(id || '') === String(tutorId)));
};

router.get('/', authMiddleware, requireDirector, ...guardianFeature, async (req, res) => {
  try {
    const [{ data: tutors, error: tutorError }, { data: players, error: playerError }] = await Promise.all([
      supabase.from('tutores').select('id,nombre,nombre_completo,rut,email,telefono,parentesco,direccion,usuario_id,acceso_activo,invitado_at,created_at')
        .eq('academia_id', req.user.academia_id).order('nombre_completo'),
      supabase.from('jugadores').select('id,nombre,tutor_id,apoderado_id,tutor_principal_id')
        .eq('academia_id', req.user.academia_id),
    ]);
    if (tutorError) throw tutorError;
    if (playerError) throw playerError;
    const tutorIds = (tutors || []).map((tutor) => tutor.id);
    const { data: links, error: linkError } = tutorIds.length
      ? await supabase.from('jugador_tutor').select('jugador_id,tutor_id').in('tutor_id', tutorIds)
      : { data: [], error: null };
    if (linkError) throw linkError;
    const playersById = new Map((players || []).map((player) => [String(player.id), player]));
    const data = (tutors || []).map((tutor) => {
      const linked = new Map();
      (players || []).filter((player) => [player.tutor_id, player.apoderado_id, player.tutor_principal_id]
        .some((id) => String(id || '') === String(tutor.id)))
        .forEach((player) => linked.set(player.id, { id: player.id, nombre: player.nombre }));
      (links || []).filter((link) => String(link.tutor_id) === String(tutor.id)).forEach((link) => {
        const player = playersById.get(String(link.jugador_id));
        if (player) linked.set(player.id, { id: player.id, nombre: player.nombre });
      });
      return { ...tutor, nombre_completo: tutor.nombre_completo || tutor.nombre || 'Apoderado', jugadores: [...linked.values()] };
    });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: 'No fue posible cargar los apoderados.' });
  }
});

router.patch('/:id', authMiddleware, requireDirector, ...guardianFeature, async (req, res) => {
  const clean = (value, max = 240) => String(value ?? '').trim().slice(0, max);
  let previousAuth = null;
  try {
    const nombreCompleto = clean(req.body?.nombre_completo, 180);
    const rut = clean(req.body?.rut, 40) || null;
    const telefono = clean(req.body?.telefono, 80) || null;
    const email = clean(req.body?.email, 240).toLowerCase() || null;
    const parentesco = clean(req.body?.parentesco, 80) || null;
    const direccion = clean(req.body?.direccion, 300) || null;
    if (!nombreCompleto) return res.status(400).json({ error: 'El nombre del apoderado es obligatorio.' });
    if (email && !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Ingresa un correo válido.' });

    const { data: tutor, error: tutorError } = await supabase.from('tutores')
      .select('id,nombre,nombre_completo,rut,email,telefono,parentesco,direccion,usuario_id')
      .eq('id', req.params.id).eq('academia_id', req.user.academia_id).maybeSingle();
    if (tutorError) throw tutorError;
    if (!tutor) return res.status(404).json({ error: 'Apoderado no encontrado.' });

    if (rut) {
      const normalized = rut.replace(/[^0-9kK]/g, '').toUpperCase();
      const { data: peers, error: peerError } = await supabase.from('tutores').select('id,rut,nombre_completo')
        .eq('academia_id', req.user.academia_id).neq('id', tutor.id);
      if (peerError) throw peerError;
      const duplicate = (peers || []).find((item) => String(item.rut || '').replace(/[^0-9kK]/g, '').toUpperCase() === normalized);
      if (duplicate) return res.status(409).json({ error: `Ya existe otro apoderado con ese RUT: ${duplicate.nombre_completo || 'Apoderado'}.` });
    }

    if (tutor.usuario_id) {
      previousAuth = { email: tutor.email || null, name: tutor.nombre_completo || tutor.nombre || 'Apoderado' };
      const authUpdate = { user_metadata: { full_name: nombreCompleto } };
      if (email && email !== String(tutor.email || '').toLowerCase()) {
        authUpdate.email = email;
        authUpdate.email_confirm = true;
      }
      const { error: authError } = await supabase.auth.admin.updateUserById(tutor.usuario_id, authUpdate);
      if (authError) {
        if (authError.status === 422 || String(authError.message || '').toLowerCase().includes('email')) {
          return res.status(409).json({ error: 'Ese correo ya está vinculado a otra cuenta de Syncademia.' });
        }
        throw authError;
      }
    }

    const { data: updated, error: updateError } = await supabase.from('tutores').update({
      nombre: nombreCompleto,
      nombre_completo: nombreCompleto,
      rut,
      telefono,
      email,
      parentesco,
      direccion,
    }).eq('id', tutor.id).eq('academia_id', req.user.academia_id)
      .select('id,nombre_completo,rut,email,telefono,parentesco,direccion,usuario_id,acceso_activo').single();
    if (updateError) throw updateError;

    if (tutor.usuario_id) {
      const { error: userError } = await supabase.from('usuarios').update({
        nombre: nombreCompleto,
        nombre_completo: nombreCompleto,
        email,
        correo: email,
      }).eq('id', tutor.usuario_id).eq('academia_id', req.user.academia_id);
      if (userError) throw userError;
    }

    return res.json({ success: true, data: updated, message: 'Datos del apoderado actualizados.' });
  } catch (error) {
    if (previousAuth) {
      try {
        const { data: currentTutor } = await supabase.from('tutores').select('usuario_id').eq('id', req.params.id).maybeSingle();
        if (currentTutor?.usuario_id) {
          const rollback = { user_metadata: { full_name: previousAuth.name } };
          if (previousAuth.email) { rollback.email = previousAuth.email; rollback.email_confirm = true; }
          await supabase.auth.admin.updateUserById(currentTutor.usuario_id, rollback);
        }
      } catch (_rollbackError) {}
    }
    console.error('Error actualizando apoderado:', error?.message || 'Error desconocido');
    return res.status(500).json({ error: 'No fue posible actualizar los datos del apoderado.' });
  }
});

router.post('/:id/acceso', authMiddleware, requireDirector, ...guardianFeature, async (req, res) => {
  let authUserId = null;
  try {
    const { data: tutor, error: tutorError } = await supabase.from('tutores')
      .select('id,nombre,nombre_completo,email,usuario_id,academias(nombre)')
      .eq('id', req.params.id).eq('academia_id', req.user.academia_id).single();
    if (tutorError || !tutor) return res.status(404).json({ error: 'Apoderado no encontrado.' });
    if (tutor.usuario_id) return res.status(409).json({ error: 'Este apoderado ya tiene una cuenta vinculada.' });
    const email = String(req.body.email || tutor.email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Ingresa un correo válido para crear el acceso.' });
    const name = tutor.nombre_completo || tutor.nombre || 'Apoderado';
    const password = temporaryPassword();
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { full_name: name },
      app_metadata: { role: 'apoderado', academia_id: req.user.academia_id },
    });
    if (authError) {
      if (authError.code === 'user_already_exists' || authError.status === 422) return res.status(409).json({ error: 'Ese correo ya tiene una cuenta en Syncademia.' });
      throw authError;
    }
    authUserId = authData.user.id;
    const { error: userError } = await supabase.from('usuarios').insert({
      id: authUserId, academia_id: req.user.academia_id,
      nombre: name, nombre_completo: name, email, correo: email,
      cargo: 'Apoderado', rol: 'apoderado', activo: true, requiere_cambio_password: true,
    });
    if (userError) throw userError;
    const { error: updateError } = await supabase.from('tutores').update({
      usuario_id: authUserId, email, acceso_activo: true, invitado_at: new Date().toISOString(),
    }).eq('id', tutor.id).eq('academia_id', req.user.academia_id);
    if (updateError) throw updateError;
    let emailSent = false;
    try {
      emailSent = await sendGuardianAccessEmail({ email, name, academyName: tutor.academias?.nombre || 'tu academia', temporaryPassword: password });
    } catch (emailError) {
      console.error('No se pudo enviar el acceso del apoderado:', emailError.message);
    }
    res.status(201).json({
      success: true, email_sent: emailSent, temporary_password: password,
      message: emailSent ? `Acceso enviado a ${email}.` : 'Acceso creado. Comparte la contraseña temporal de forma segura.',
    });
  } catch (error) {
    if (authUserId) {
      await supabase.from('tutores').update({ usuario_id: null, acceso_activo: false }).eq('usuario_id', authUserId);
      await supabase.from('usuarios').delete().eq('id', authUserId);
      await supabase.auth.admin.deleteUser(authUserId);
    }
    res.status(500).json({ error: error.message || 'No fue posible crear el acceso.' });
  }
});

router.patch('/:id/estado', authMiddleware, requireDirector, ...guardianFeature, async (req, res) => {
  try {
    const active = req.body.activo === true;
    const { data: tutor, error } = await supabase.from('tutores').select('id,usuario_id')
      .eq('id', req.params.id).eq('academia_id', req.user.academia_id).single();
    if (error || !tutor) return res.status(404).json({ error: 'Apoderado no encontrado.' });
    if (!tutor.usuario_id) return res.status(409).json({ error: 'Este apoderado todavía no tiene una cuenta.' });
    const [{ error: tutorUpdateError }, { error: userUpdateError }] = await Promise.all([
      supabase.from('tutores').update({ acceso_activo: active }).eq('id', tutor.id),
      supabase.from('usuarios').update({ activo: active }).eq('id', tutor.usuario_id).eq('academia_id', req.user.academia_id),
    ]);
    if (tutorUpdateError) throw tutorUpdateError;
    if (userUpdateError) throw userUpdateError;
    res.json({ success: true, message: active ? 'Acceso reactivado.' : 'Acceso desactivado.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/reset-password', authMiddleware, requireDirector, ...guardianFeature, async (req, res) => {
  try {
    const { data: tutor, error } = await supabase.from('tutores')
      .select('id,usuario_id,email,nombre,nombre_completo,academias(nombre)')
      .eq('id', req.params.id).eq('academia_id', req.user.academia_id).single();
    if (error || !tutor) return res.status(404).json({ error: 'Apoderado no encontrado.' });
    if (!tutor.usuario_id) return res.status(409).json({ error: 'Este apoderado todavía no tiene una cuenta.' });
    const password = temporaryPassword();
    const { error: authError } = await supabase.auth.admin.updateUserById(tutor.usuario_id, { password });
    if (authError) throw authError;
    await supabase.from('usuarios').update({ requiere_cambio_password: true }).eq('id', tutor.usuario_id);
    let emailSent = false;
    try {
      emailSent = await sendGuardianAccessEmail({
        email: tutor.email, name: tutor.nombre_completo || tutor.nombre || 'Apoderado',
        academyName: tutor.academias?.nombre || 'tu academia', temporaryPassword: password,
      });
    } catch (emailError) {
      console.error('No se pudo enviar la nueva clave del apoderado:', emailError.message);
    }
    res.json({ success: true, email_sent: emailSent, temporary_password: password, message: emailSent ? 'Nueva clave enviada.' : 'Nueva clave generada.' });
  } catch (error) {
    res.status(500).json({ error: 'No fue posible restablecer la contraseña.' });
  }
});

router.get('/me', authMiddleware, requireGuardian, ...guardianFeature, async (req, res) => {
  try {
    const { data: tutor, error: tutorError } = await supabase.from('tutores')
      .select('id,nombre,nombre_completo,email,telefono,parentesco,acceso_activo,academias(id,nombre,logo,logo_url)')
      .eq('usuario_id', req.user.id).eq('academia_id', req.user.academia_id).eq('acceso_activo', true).single();
    if (tutorError || !tutor) return res.status(403).json({ error: 'Tu acceso de apoderado no está activo.' });
    const players = await getTutorPlayers(req.user.academia_id, tutor.id);
    const playerIds = uniqueIds(players.map((player) => player.id));
    const playerCategoryResult = playerIds.length
      ? await supabase.from('jugador_categoria').select('categoria_id').in('jugador_id', playerIds)
      : { data: [], error: null };
    if (playerCategoryResult.error) throw playerCategoryResult.error;
    const categoryIds = uniqueIds([
      ...players.map((player) => player.categoria_id),
      ...(playerCategoryResult.data || []).map((item) => item.categoria_id),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const [matchesResult, attendanceResult, chargesResult, paymentConfigResult] = await Promise.all([
      categoryIds.length ? supabase.from('partidos')
        .select('id,rival,fecha,hora,hora_citacion,ubicacion,condicion,color_uniforme,categoria_id,categorias(nombre)')
        .eq('academia_id', req.user.academia_id).in('categoria_id', categoryIds).gte('fecha', today)
        .neq('estado', 'Jugado').order('fecha').order('hora').limit(20) : Promise.resolve({ data: [], error: null }),
      playerIds.length ? supabase.from('asistencias')
        .select('id,jugador_id,estado,created_at,entrenamientos(fecha,hora,categoria_id)')
        .in('jugador_id', playerIds).order('created_at', { ascending: false }).limit(60) : Promise.resolve({ data: [], error: null }),
      playerIds.length ? supabase.from('cobros')
        .select('id,jugador_id,concepto,monto,monto_pagado,estado,fecha_vencimiento')
        .eq('academia_id', req.user.academia_id).in('jugador_id', playerIds)
        .order('fecha_vencimiento', { ascending: false }).limit(100) : Promise.resolve({ data: [], error: null }),
      supabase.from('configuracion_financiera')
        .select('acepta_efectivo,acepta_transferencia,acepta_pago_online,transferencia_banco,transferencia_tipo_cuenta,transferencia_numero,transferencia_rut,transferencia_correo,link_pago_online')
        .eq('academia_id', req.user.academia_id).maybeSingle(),
    ]);
    if (matchesResult.error) throw matchesResult.error;
    if (attendanceResult.error) throw attendanceResult.error;
    if (chargesResult.error) throw chargesResult.error;
    if (paymentConfigResult.error) throw paymentConfigResult.error;
    const pending = (chargesResult.data || []).reduce((sum, charge) => sum + Math.max(Number(charge.monto || 0) - Number(charge.monto_pagado || 0), 0), 0);
    res.json({
      success: true,
      data: {
        apoderado: { id: tutor.id, nombre: tutor.nombre_completo || tutor.nombre, email: tutor.email, telefono: tutor.telefono },
        academia: tutor.academias,
        jugadores: players.map(({ tutor_id: _tutor, apoderado_id: _guardian, tutor_principal_id: _principal, ...player }) => player),
        proximos_partidos: matchesResult.data || [],
        asistencias_recientes: attendanceResult.data || [],
        finanzas: { saldo_pendiente: pending, cobros: chargesResult.data || [], metodos_pago: paymentConfigResult.data || null },
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'No fue posible cargar tu portal de apoderado.' });
  }
});

module.exports = router;
