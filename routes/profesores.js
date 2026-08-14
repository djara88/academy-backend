const crypto = require('crypto');
const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector, requireProfessor } = require('../middleware/professorAccess');
const { getProfessorLimit } = require('../services/planLimits');
const { sendProfessorAccessEmail } = require('../services/accessEmail');

const router = express.Router();
const ATTENDANCE_STATES = new Set(['Presente', 'Ausente', 'Justificado']);

const createTemporaryPassword = () => `${crypto.randomBytes(9).toString('base64url')}A9!`;
const cleanText = (value) => String(value || '').trim();
const uniqueIds = (values) => [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];

const getAcademyProfessorUsage = async (academyId) => {
  const [{ data: academy, error: academyError }, { count, error: countError }] = await Promise.all([
    supabase.from('academias').select('id,nombre,plan,max_profesores').eq('id', academyId).single(),
    supabase.from('usuarios').select('id', { count: 'exact', head: true })
      .eq('academia_id', academyId).eq('rol', 'profesor').eq('activo', true),
  ]);
  if (academyError) throw academyError;
  if (countError) throw countError;
  const max = getProfessorLimit(academy);
  return { academy, used: count || 0, max, remaining: Math.max(max - (count || 0), 0) };
};

const validateCategories = async (academyId, categoryIds, excludedProfessorId = null) => {
  const ids = uniqueIds(categoryIds);
  if (!ids.length) throw Object.assign(new Error('Debes asignar al menos una categoría.'), { status: 400 });

  const { data: categories, error } = await supabase
    .from('categorias').select('id,nombre').eq('academia_id', academyId).in('id', ids);
  if (error) throw error;
  if ((categories || []).length !== ids.length) {
    throw Object.assign(new Error('Una o más categorías no pertenecen a tu academia.'), { status: 400 });
  }

  let assignmentQuery = supabase.from('profesor_categorias')
    .select('categoria_id,profesor_id')
    .eq('academia_id', academyId).eq('activo', true).in('categoria_id', ids);
  if (excludedProfessorId) assignmentQuery = assignmentQuery.neq('profesor_id', excludedProfessorId);
  const { data: occupied, error: occupiedError } = await assignmentQuery;
  if (occupiedError) throw occupiedError;
  if (occupied?.length) {
    const names = occupied.map((item) => categories.find((cat) => cat.id === item.categoria_id)?.nombre).filter(Boolean);
    throw Object.assign(new Error(`Ya existe un profesor titular en: ${names.join(', ')}.`), { status: 409 });
  }
  return categories;
};

const requireAssignedCategory = async (user, categoryId) => {
  const { data, error } = await supabase.from('profesor_categorias').select('id')
    .eq('academia_id', user.academia_id).eq('profesor_id', user.id)
    .eq('categoria_id', categoryId).eq('activo', true).maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Esta categoría no está asignada a tu perfil.'), { status: 403 });
};

const getCategoryPlayers = async (academyId, categoryId) => {
  const { data: links, error: linkError } = await supabase.from('jugador_categoria')
    .select('jugador_id').eq('categoria_id', categoryId);
  if (linkError) throw linkError;

  const linkedIds = uniqueIds((links || []).map((link) => link.jugador_id));
  const select = 'id,nombre,posicion_cancha,posicion_principal,foto_url,avatar_url';
  const queries = [
    supabase.from('jugadores').select(select).eq('academia_id', academyId).eq('categoria_id', categoryId),
  ];
  if (linkedIds.length) queries.push(supabase.from('jugadores').select(select).eq('academia_id', academyId).in('id', linkedIds));
  const results = await Promise.all(queries);
  results.forEach(({ error }) => { if (error) throw error; });

  const byId = new Map();
  results.flatMap(({ data }) => data || []).forEach((player) => byId.set(player.id, player));
  return [...byId.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
};

router.get('/', authMiddleware, requireDirector, async (req, res) => {
  try {
    const usage = await getAcademyProfessorUsage(req.user.academia_id);
    const [{ data: professors, error: professorsError }, { data: categories, error: categoriesError }, { data: assignments, error: assignmentsError }] = await Promise.all([
      supabase.from('usuarios').select('id,nombre_completo,email,telefono,activo,ultimo_acceso,created_at')
        .eq('academia_id', req.user.academia_id).eq('rol', 'profesor').order('created_at'),
      supabase.from('categorias').select('id,nombre,descripcion').eq('academia_id', req.user.academia_id).order('nombre'),
      supabase.from('profesor_categorias').select('id,profesor_id,categoria_id,activo').eq('academia_id', req.user.academia_id).eq('activo', true),
    ]);
    if (professorsError) throw professorsError;
    if (categoriesError) throw categoriesError;
    if (assignmentsError) throw assignmentsError;
    const categoryMap = new Map((categories || []).map((category) => [category.id, category]));
    const data = (professors || []).map((professor) => ({
      ...professor,
      categorias: (assignments || []).filter((item) => item.profesor_id === professor.id)
        .map((item) => categoryMap.get(item.categoria_id)).filter(Boolean),
    }));
    res.json({ success: true, data, categorias: categories || [], cupos: { used: usage.used, max: usage.max, remaining: usage.remaining }, plan: usage.academy.plan });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', authMiddleware, requireDirector, async (req, res) => {
  const name = cleanText(req.body.nombre_completo);
  const email = cleanText(req.body.email).toLowerCase();
  const phone = cleanText(req.body.telefono);
  const categoryIds = uniqueIds(req.body.categoria_ids);
  let authUserId = null;

  try {
    if (name.length < 3 || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Ingresa un nombre y un correo válidos.' });
    }
    const usage = await getAcademyProfessorUsage(req.user.academia_id);
    if (usage.used >= usage.max) {
      return res.status(409).json({ error: `Tu plan permite ${usage.max} profesor${usage.max === 1 ? '' : 'es'}. Puedes ampliar el plan para agregar más.` });
    }
    await validateCategories(req.user.academia_id, categoryIds);

    const temporaryPassword = createTemporaryPassword();
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password: temporaryPassword,
      email_confirm: true,
      user_metadata: { full_name: name },
      app_metadata: { role: 'profesor', academia_id: req.user.academia_id },
    });
    if (authError) {
      if (authError.code === 'user_already_exists' || authError.status === 422) {
        return res.status(409).json({ error: 'Ese correo ya está registrado en Syncademia.' });
      }
      throw authError;
    }
    authUserId = authData.user.id;

    const { error: userError } = await supabase.from('usuarios').insert({
      id: authUserId,
      academia_id: req.user.academia_id,
      nombre: name,
      nombre_completo: name,
      email,
      correo: email,
      telefono: phone || null,
      cargo: 'Profesor',
      rol: 'profesor',
      activo: true,
      requiere_cambio_password: true,
    });
    if (userError) throw userError;

    const { error: assignmentError } = await supabase.from('profesor_categorias').insert(categoryIds.map((categoryId) => ({
      academia_id: req.user.academia_id,
      profesor_id: authUserId,
      categoria_id: categoryId,
      assigned_by: req.user.id,
    })));
    if (assignmentError) throw assignmentError;

    let emailSent = false;
    try {
      emailSent = await sendProfessorAccessEmail({ email, name, academyName: usage.academy.nombre, temporaryPassword });
    } catch (emailError) {
      console.error('No se pudo enviar el acceso del profesor:', emailError.message);
    }

    res.status(201).json({
      success: true,
      message: emailSent ? `Acceso enviado a ${email}.` : 'Profesor creado. Comparte la contraseña temporal de forma segura.',
      temporary_password: temporaryPassword,
      email_sent: emailSent,
      id: authUserId,
    });
  } catch (error) {
    if (authUserId) {
      await supabase.from('profesor_categorias').delete().eq('profesor_id', authUserId);
      await supabase.from('usuarios').delete().eq('id', authUserId);
      await supabase.auth.admin.deleteUser(authUserId);
    }
    res.status(error.status || 500).json({ error: error.message || 'No fue posible crear al profesor.' });
  }
});

router.put('/:id', authMiddleware, requireDirector, async (req, res) => {
  try {
    const professorId = req.params.id;
    const categoryIds = uniqueIds(req.body.categoria_ids);
    const { data: professor, error: professorError } = await supabase.from('usuarios').select('id,activo')
      .eq('id', professorId).eq('academia_id', req.user.academia_id).eq('rol', 'profesor').single();
    if (professorError || !professor) return res.status(404).json({ error: 'Profesor no encontrado.' });
    await validateCategories(req.user.academia_id, categoryIds, professorId);

    const update = {};
    if (req.body.nombre_completo !== undefined) {
      const name = cleanText(req.body.nombre_completo);
      if (name.length < 3) return res.status(400).json({ error: 'El nombre es demasiado corto.' });
      update.nombre = name;
      update.nombre_completo = name;
    }
    if (req.body.telefono !== undefined) update.telefono = cleanText(req.body.telefono) || null;

    if (Object.keys(update).length) {
      const { error: updateError } = await supabase.from('usuarios').update(update).eq('id', professorId);
      if (updateError) throw updateError;
    }
    const { data: oldAssignments, error: oldError } = await supabase.from('profesor_categorias').select('id,categoria_id')
      .eq('profesor_id', professorId).eq('academia_id', req.user.academia_id).eq('activo', true);
    if (oldError) throw oldError;
    await supabase.from('profesor_categorias').update({ activo: false }).eq('profesor_id', professorId).eq('activo', true);
    const oldIds = new Set((oldAssignments || []).map((item) => item.categoria_id));
    const keepIds = categoryIds.filter((id) => oldIds.has(id));
    if (keepIds.length) await supabase.from('profesor_categorias').update({ activo: true, assigned_by: req.user.id }).eq('profesor_id', professorId).in('categoria_id', keepIds);
    const newIds = categoryIds.filter((id) => !oldIds.has(id));
    if (newIds.length) {
      const { error: insertError } = await supabase.from('profesor_categorias').insert(newIds.map((categoryId) => ({
        academia_id: req.user.academia_id, profesor_id: professorId, categoria_id: categoryId, assigned_by: req.user.id,
      })));
      if (insertError) {
        await supabase.from('profesor_categorias').update({ activo: true }).eq('profesor_id', professorId).in('id', (oldAssignments || []).map((item) => item.id));
        throw insertError;
      }
    }
    res.json({ success: true, message: 'Profesor y categorías actualizados.' });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.patch('/:id/estado', authMiddleware, requireDirector, async (req, res) => {
  try {
    const active = req.body.activo === true;
    const professorId = req.params.id;
    const { data: professor, error } = await supabase.from('usuarios').select('id,activo')
      .eq('id', professorId).eq('academia_id', req.user.academia_id).eq('rol', 'profesor').single();
    if (error || !professor) return res.status(404).json({ error: 'Profesor no encontrado.' });
    if (active && !professor.activo) {
      const usage = await getAcademyProfessorUsage(req.user.academia_id);
      if (usage.used >= usage.max) return res.status(409).json({ error: `No quedan cupos en tu plan (${usage.max}).` });
    }
    const { error: updateError } = await supabase.from('usuarios').update({ activo: active }).eq('id', professorId);
    if (updateError) throw updateError;
    if (!active) await supabase.from('profesor_categorias').update({ activo: false }).eq('profesor_id', professorId);
    res.json({ success: true, message: active ? 'Acceso reactivado.' : 'Acceso desactivado.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/reset-password', authMiddleware, requireDirector, async (req, res) => {
  try {
    const { data: professor, error } = await supabase.from('usuarios').select('id,email,nombre_completo,academias(nombre)')
      .eq('id', req.params.id).eq('academia_id', req.user.academia_id).eq('rol', 'profesor').single();
    if (error || !professor) return res.status(404).json({ error: 'Profesor no encontrado.' });
    const temporaryPassword = createTemporaryPassword();
    const { error: authError } = await supabase.auth.admin.updateUserById(professor.id, { password: temporaryPassword });
    if (authError) throw authError;
    await supabase.from('usuarios').update({ requiere_cambio_password: true }).eq('id', professor.id);
    let emailSent = false;
    try {
      emailSent = await sendProfessorAccessEmail({ email: professor.email, name: professor.nombre_completo, academyName: professor.academias?.nombre || 'tu academia', temporaryPassword });
    } catch (emailError) {
      console.error('No se pudo enviar la nueva clave:', emailError.message);
    }
    res.json({ success: true, temporary_password: temporaryPassword, email_sent: emailSent });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/me', authMiddleware, requireProfessor, async (req, res) => {
  try {
    const [{ data: academy, error: academyError }, { data: assignments, error: assignmentError }] = await Promise.all([
      supabase.from('academias').select('id,nombre,logo,logo_url').eq('id', req.user.academia_id).single(),
      supabase.from('profesor_categorias').select('categoria_id,categorias(id,nombre,descripcion)')
        .eq('academia_id', req.user.academia_id).eq('profesor_id', req.user.id).eq('activo', true),
    ]);
    if (academyError) throw academyError;
    if (assignmentError) throw assignmentError;
    res.json({ success: true, data: { profesor: { id: req.user.id, nombre: req.user.nombre_completo }, academia: academy, categorias: (assignments || []).map((item) => item.categorias).filter(Boolean) } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/me/categorias/:categoriaId/asistencia', authMiddleware, requireProfessor, async (req, res) => {
  try {
    const date = cleanText(req.query.fecha) || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Fecha inválida.' });
    await requireAssignedCategory(req.user, req.params.categoriaId);
    const players = await getCategoryPlayers(req.user.academia_id, req.params.categoriaId);
    const { data: training, error: trainingError } = await supabase.from('entrenamientos').select('id,hora,lugar,created_at')
      .eq('academia_id', req.user.academia_id).eq('categoria_id', req.params.categoriaId)
      .eq('fecha', date).eq('estado', 'Realizado').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (trainingError) throw trainingError;
    let attendance = [];
    if (training) {
      const { data, error } = await supabase.from('asistencias').select('jugador_id,estado').eq('entrenamiento_id', training.id);
      if (error) throw error;
      attendance = data || [];
    }
    const byPlayer = new Map(attendance.map((item) => [item.jugador_id, item.estado]));
    res.json({ success: true, data: { fecha: date, entrenamiento: training, jugadores: players.map((player) => ({ ...player, estado_asistencia: byPlayer.get(player.id) || null })) } });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/me/categorias/:categoriaId/asistencia', authMiddleware, requireProfessor, async (req, res) => {
  try {
    const date = cleanText(req.body.fecha);
    const items = Array.isArray(req.body.asistencias) ? req.body.asistencias : [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !items.length) return res.status(400).json({ error: 'La fecha y la lista de asistencia son obligatorias.' });
    if (items.some((item) => !item.jugador_id || !ATTENDANCE_STATES.has(item.estado))) return res.status(400).json({ error: 'La lista contiene estados de asistencia inválidos.' });
    await requireAssignedCategory(req.user, req.params.categoriaId);
    const players = await getCategoryPlayers(req.user.academia_id, req.params.categoriaId);
    const playerIds = new Set(players.map((player) => player.id));
    if (items.some((item) => !playerIds.has(String(item.jugador_id)))) return res.status(403).json({ error: 'La lista contiene un jugador ajeno a tu categoría.' });

    let { data: training, error: trainingError } = await supabase.from('entrenamientos').select('id')
      .eq('academia_id', req.user.academia_id).eq('categoria_id', req.params.categoriaId)
      .eq('fecha', date).eq('estado', 'Realizado').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (trainingError) throw trainingError;
    if (!training) {
      const { data, error } = await supabase.from('entrenamientos').insert({
        academia_id: req.user.academia_id,
        categoria_id: req.params.categoriaId,
        fecha: date,
        hora: new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Santiago' }),
        estado: 'Realizado',
        es_recuperacion: false,
        registrado_por: req.user.id,
      }).select('id').single();
      if (error) throw error;
      training = data;
    }
    const rows = items.map((item) => ({ entrenamiento_id: training.id, jugador_id: item.jugador_id, estado: item.estado, registrado_por: req.user.id, actualizado_at: new Date().toISOString() }));
    const { error: attendanceError } = await supabase.from('asistencias').upsert(rows, { onConflict: 'entrenamiento_id,jugador_id' });
    if (attendanceError) throw attendanceError;
    await supabase.from('usuarios').update({ ultimo_acceso: new Date().toISOString() }).eq('id', req.user.id);
    res.json({ success: true, message: `Asistencia guardada: ${items.length} jugadores.`, entrenamiento_id: training.id });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

module.exports = router;
