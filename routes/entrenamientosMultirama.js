const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { enviarMensaje } = require('../services/whatsappService');
const { academyMessage, getAcademyName } = require('../services/academyIdentity');
const { resolveCompetitiveProfile } = require('../services/competitiveStatsCatalog');
const {
  getBranch,
  getCategoryContext,
  getStudentsForScope,
  safeText,
  uniqueIds,
} = require('../services/branchContext');

const router = express.Router();
router.use(authMiddleware);

const dateRange = (month, year) => {
  const monthNumber = Math.min(12, Math.max(1, Number(month) || new Date().getMonth() + 1));
  const yearNumber = Math.min(2100, Math.max(2020, Number(year) || new Date().getFullYear()));
  const first = `${yearNumber}-${String(monthNumber).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(yearNumber, monthNumber, 0)).getUTCDate();
  return { first, last: `${yearNumber}-${String(monthNumber).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}` };
};

router.post('/', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const categoryId = safeText(req.body?.categoria_id, 80);
    const branchId = safeText(req.body?.rama_id, 80);
    const date = safeText(req.body?.fecha, 10);
    if (!date || !categoryId) return res.status(400).json({ success: false, error: 'Falta la fecha o la categoría.' });

    if (categoryId === 'TODAS') {
      let categoryQuery = supabase.from('categorias')
        .select('id,nombre,sede_id,rama_id')
        .eq('academia_id', academyId)
        .not('rama_id', 'is', null)
        .not('sede_id', 'is', null);
      if (branchId) {
        await getBranch(academyId, branchId);
        categoryQuery = categoryQuery.eq('rama_id', branchId);
      }
      const { data: categories, error } = await categoryQuery;
      if (error) throw error;
      if (!categories?.length) return res.status(400).json({ success: false, error: 'No hay categorías en el alcance seleccionado.' });
      const rows = categories.map((category) => ({
        academia_id: academyId,
        categoria_id: category.id,
        sede_id: category.sede_id,
        rama_id: category.rama_id,
        fecha: date,
        hora: safeText(req.body?.hora, 20) || '17:00',
        lugar: safeText(req.body?.lugar, 300),
        estado: safeText(req.body?.estado, 40) || 'Cancelado',
        es_recuperacion: false,
        motivo_cancelacion: safeText(req.body?.motivo_cancelacion, 1000) || 'Suspensión general',
        clase_recuperada_id: null,
        registrado_por: req.user.id,
      }));
      const { data, error: insertError } = await supabase.from('entrenamientos').insert(rows).select('id');
      if (insertError) throw insertError;
      return res.json({ success: true, message: `Se registró la suspensión para ${data.length} categorías${branchId ? ' de la rama seleccionada' : ' de la academia'}.` });
    }

    const { category } = await getCategoryContext(academyId, categoryId);
    if (branchId && String(branchId) !== String(category.rama_id)) {
      return res.status(409).json({ error: 'La categoría no pertenece a la rama seleccionada.', code: 'CATEGORY_BRANCH_MISMATCH' });
    }
    const attendance = Array.isArray(req.body?.lista_asistencia) ? req.body.lista_asistencia : [];
    if ((req.body?.estado || 'Realizado') === 'Realizado' && attendance.length) {
      const studentIds = uniqueIds(attendance.map((item) => item.jugador_id));
      const eligible = await getStudentsForScope({ academyId, branchId: category.rama_id, categoryId: category.id, playerIds: studentIds });
      if (eligible.length !== studentIds.length) return res.status(403).json({ error: 'La asistencia contiene un alumno ajeno a esta rama/categoría.' });
    }

    const { data: training, error } = await supabase.from('entrenamientos').insert({
      academia_id: academyId,
      categoria_id: category.id,
      sede_id: category.sede_id,
      rama_id: category.rama_id,
      fecha: date,
      hora: safeText(req.body?.hora, 20) || '17:00',
      lugar: safeText(req.body?.lugar, 300),
      estado: safeText(req.body?.estado, 40) || 'Realizado',
      es_recuperacion: req.body?.es_recuperacion === true,
      motivo_cancelacion: safeText(req.body?.motivo_cancelacion, 1000),
      clase_recuperada_id: req.body?.clase_recuperada_id || null,
      registrado_por: req.user.id,
    }).select('*').single();
    if (error) throw error;

    if (training.estado === 'Realizado' && attendance.length) {
      const rows = attendance.map((item) => ({
        entrenamiento_id: training.id,
        jugador_id: item.jugador_id,
        estado: ['Presente','Ausente','Justificado'].includes(item.estado) ? item.estado : 'Presente',
        registrado_por: req.user.id,
        actualizado_at: new Date().toISOString(),
      }));
      const { error: attendanceError } = await supabase.from('asistencias').upsert(rows, { onConflict: 'entrenamiento_id,jugador_id' });
      if (attendanceError) throw attendanceError;
    }
    return res.json({ success: true, data: training });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible registrar el entrenamiento.' });
  }
});

router.get('/suspendidas', async (req, res) => {
  try {
    const branchId = safeText(req.query?.rama_id, 80);
    let query = supabase.from('entrenamientos')
      .select('*,categorias(id,nombre,rama_id),ramas(id,nombre,disciplina),sedes(id,nombre)')
      .eq('academia_id', req.user.academia_id)
      .eq('estado', 'Cancelado')
      .order('fecha', { ascending: false });
    if (branchId) query = query.eq('rama_id', branchId);
    const { data, error } = await query;
    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'No fue posible cargar las clases suspendidas.' });
  }
});

router.post('/reagendar-notificar', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const academyName = await getAcademyName(academyId);
    const { category, branch } = await getCategoryContext(academyId, req.body?.categoria_id);
    const date = safeText(req.body?.fecha, 10);
    const time = safeText(req.body?.hora, 20);
    if (!date || !time) return res.status(400).json({ error: 'Fecha y hora son obligatorias.' });
    const { data: training, error } = await supabase.from('entrenamientos').insert({
      academia_id: academyId,
      categoria_id: category.id,
      sede_id: category.sede_id,
      rama_id: category.rama_id,
      fecha: date,
      hora: time,
      lugar: safeText(req.body?.lugar, 300),
      estado: 'Programado',
      es_recuperacion: true,
      clase_recuperada_id: req.body?.clase_cancelada_id || null,
      registrado_por: req.user.id,
    }).select('*,categorias(id,nombre),ramas(id,nombre,disciplina)').single();
    if (error) throw error;

    const students = await getStudentsForScope({
      academyId,
      branchId: category.rama_id,
      categoryId: category.id,
      playerSelect: 'id,nombre,tutor_id',
    });
    const tutorIds = uniqueIds(students.map((student) => student.tutor_id));
    let tutorMap = new Map();
    if (tutorIds.length) {
      const { data: tutors, error: tutorError } = await supabase.from('tutores')
        .select('id,nombre_completo,telefono').eq('academia_id', academyId).in('id', tutorIds);
      if (tutorError) throw tutorError;
      tutorMap = new Map((tutors || []).map((tutor) => [String(tutor.id), tutor]));
    }
    const profile = resolveCompetitiveProfile({ discipline: branch?.disciplina || 'Otro' });
    const formattedDate = new Date(`${date}T12:00:00`).toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    let sent = 0;
    for (const student of students) {
      const tutor = tutorMap.get(String(student.tutor_id));
      if (!tutor?.telefono) continue;
      let phone = String(tutor.telefono).replace(/\D/g, '');
      if (!phone.startsWith('56') && phone.length === 9) phone = `56${phone}`;
      const message = academyMessage(academyName,
        `📢 *CLASE DE RECUPERACIÓN · ${profile.label.toUpperCase()}*\n\nHola ${tutor.nombre_completo || 'Apoderado/a'},\n` +
        `la clase de *${category.nombre}* fue reagendada.\n${profile.icon} *Rama:* ${branch?.nombre || profile.label}\n📅 *Fecha:* ${formattedDate}\n⏰ *Hora:* ${time} hrs\n📍 *Lugar:* ${training.lugar || 'Por confirmar'}`);
      try { await enviarMensaje(academyId, phone, message); sent += 1; }
      catch (sendError) { console.error('No se pudo enviar recuperación:', sendError?.message || sendError); }
    }
    return res.json({ success: true, message: `Clase de recuperación programada y notificada a ${sent} apoderados.`, data: training });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible reagendar la clase.' });
  }
});

router.get('/metricas', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const branchId = safeText(req.query?.rama_id, 80);
    const { first, last } = dateRange(req.query?.mes, req.query?.anio);
    let trainingQuery = supabase.from('entrenamientos')
      .select('id,categoria_id,rama_id,fecha,estado,es_recuperacion,categorias(id,nombre),ramas(id,nombre,disciplina)')
      .eq('academia_id', academyId)
      .gte('fecha', first).lte('fecha', last);
    if (branchId) trainingQuery = trainingQuery.eq('rama_id', branchId);
    const { data: trainings, error } = await trainingQuery;
    if (error) throw error;
    const list = trainings || [];
    const ids = list.map((item) => item.id);
    let attendance = [];
    if (ids.length) {
      const result = await supabase.from('asistencias')
        .select('estado,jugador_id,entrenamiento_id,jugadores(id,nombre)')
        .in('entrenamiento_id', ids);
      if (result.error) throw result.error;
      attendance = result.data || [];
    }
    const trainingMap = new Map(list.map((item) => [String(item.id), item]));
    const catStats = new Map();
    const studentStats = new Map();
    let presentes = 0; let ausentes = 0; let justificados = 0;
    for (const item of attendance) {
      if (item.estado === 'Presente') presentes += 1;
      else if (item.estado === 'Ausente') ausentes += 1;
      else if (item.estado === 'Justificado') justificados += 1;
      const training = trainingMap.get(String(item.entrenamiento_id));
      if (training?.categoria_id) {
        const current = catStats.get(String(training.categoria_id)) || { nombre: training.categorias?.nombre || 'Categoría', presentes: 0, total: 0 };
        current.total += 1; if (item.estado === 'Presente') current.presentes += 1; catStats.set(String(training.categoria_id), current);
      }
      if (item.jugador_id && item.jugadores) {
        const current = studentStats.get(String(item.jugador_id)) || { nombre: item.jugadores.nombre, presentes: 0, total: 0 };
        current.total += 1; if (item.estado === 'Presente') current.presentes += 1; studentStats.set(String(item.jugador_id), current);
      }
    }
    const totalRecords = presentes + ausentes + justificados;
    const categories = [...catStats.values()].map((item) => ({ ...item, porcentaje: item.total ? Math.round((item.presentes / item.total) * 100) : 0 })).sort((a,b) => b.porcentaje - a.porcentaje);
    const students = [...studentStats.values()].map((item) => ({ ...item, porcentaje: item.total ? Math.round((item.presentes / item.total) * 100) : 0 })).sort((a,b) => b.porcentaje - a.porcentaje);
    return res.json({ success: true, data: {
      global: {
        totalClases: list.filter((item) => item.estado === 'Realizado').length,
        canceladas: list.filter((item) => item.estado === 'Cancelado').length,
        recuperativas: list.filter((item) => item.es_recuperacion).length,
        porcentajeGlobal: totalRecords ? Math.round((presentes / totalRecords) * 100) : 0,
        totalPresentes: presentes, totalAusentes: ausentes, totalJustificados: justificados,
      },
      categorias: categories,
      jugadores: students,
      rama_id: branchId || null,
    } });
  } catch (error) {
    return res.status(500).json({ success: false, error: error?.message || 'No fue posible cargar métricas.' });
  }
});

router.post('/reporte-mensual', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const academyName = await getAcademyName(academyId);
    const { category, branch } = await getCategoryContext(academyId, req.body?.categoria_id);
    const { first, last } = dateRange(req.body?.mes, req.body?.anio);
    const { data: trainings, error } = await supabase.from('entrenamientos')
      .select('id').eq('academia_id', academyId).eq('categoria_id', category.id).eq('rama_id', category.rama_id)
      .eq('estado', 'Realizado').gte('fecha', first).lte('fecha', last);
    if (error) throw error;
    const trainingIds = (trainings || []).map((item) => item.id);
    if (!trainingIds.length) return res.status(400).json({ error: 'No hay clases realizadas en este período para la categoría.' });
    const students = await getStudentsForScope({ academyId, branchId: category.rama_id, categoryId: category.id, playerSelect: 'id,nombre,tutor_id' });
    const studentMap = new Map(students.map((student) => [String(student.id), student]));
    const { data: attendance, error: attendanceError } = await supabase.from('asistencias')
      .select('jugador_id,estado').in('entrenamiento_id', trainingIds);
    if (attendanceError) throw attendanceError;
    const report = new Map();
    for (const row of attendance || []) {
      const student = studentMap.get(String(row.jugador_id));
      if (!student) continue;
      const current = report.get(String(student.id)) || { student, presentes: 0, ausentes: 0, justificados: 0 };
      if (row.estado === 'Presente') current.presentes += 1;
      else if (row.estado === 'Ausente') current.ausentes += 1;
      else if (row.estado === 'Justificado') current.justificados += 1;
      report.set(String(student.id), current);
    }
    const tutorIds = uniqueIds([...report.values()].map((item) => item.student.tutor_id));
    let tutorMap = new Map();
    if (tutorIds.length) {
      const result = await supabase.from('tutores').select('id,nombre_completo,telefono').eq('academia_id', academyId).in('id', tutorIds);
      if (result.error) throw result.error;
      tutorMap = new Map((result.data || []).map((tutor) => [String(tutor.id), tutor]));
    }
    const profile = resolveCompetitiveProfile({ discipline: branch?.disciplina || 'Otro' });
    let sent = 0;
    for (const item of report.values()) {
      const tutor = tutorMap.get(String(item.student.tutor_id));
      if (!tutor?.telefono) continue;
      let phone = String(tutor.telefono).replace(/\D/g, '');
      if (!phone.startsWith('56') && phone.length === 9) phone = `56${phone}`;
      const total = item.presentes + item.ausentes + item.justificados;
      const percentage = total ? Math.round(((item.presentes + item.justificados) / total) * 100) : 0;
      const message = academyMessage(academyName,
        `📊 *REPORTE DE ASISTENCIA · ${profile.label.toUpperCase()}*\n\nAlumno/a: *${item.student.nombre}*\nRama: *${branch?.nombre || profile.label}*\nCategoría: *${category.nombre}*\n\n✅ Presente: ${item.presentes}\n🟡 Justificado: ${item.justificados}\n❌ Ausente: ${item.ausentes}\n📈 Cumplimiento: *${percentage}%*`);
      try { await enviarMensaje(academyId, phone, message); sent += 1; }
      catch (sendError) { console.error('No se pudo enviar reporte:', sendError?.message || sendError); }
    }
    return res.json({ success: true, message: `Reportes enviados a ${sent} apoderados.`, enviados: sent });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible enviar reportes.' });
  }
});

module.exports = router;
