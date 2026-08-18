const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { enviarMensaje } = require('../services/whatsappService');
const { academyMessage, getAcademyName } = require('../services/academyIdentity');
const {
  getBranch,
  getCategoryContext,
  getStudentsForScope,
  safeText,
  uniqueIds,
} = require('../services/branchContext');

const router = express.Router();
router.use(authMiddleware, requireDirector);

const documentOf = (student) => student.rut || student.rut_pasaporte || student.numero_documento || null;
const photoOf = (student) => student.foto_base64 || student.foto_url || student.avatar_url || null;
const normalizePhone = (value) => {
  let phone = String(value || '').replace(/\D/g, '');
  if (!phone.startsWith('56') && phone.length === 9) phone = `56${phone}`;
  return phone;
};
const attendanceStatus = (value) => ['Presente', 'Ausente', 'Justificado'].includes(value) ? value : 'Presente';

const notifyAbsences = async ({ academyId, category, branch, training, students, attendance }) => {
  const absentIds = new Set(
    attendance
      .filter((item) => attendanceStatus(item?.estado) === 'Ausente')
      .map((item) => String(item?.jugador_id || ''))
      .filter(Boolean),
  );
  if (!absentIds.size) return { solicitadas: 0, enviadas: 0, omitidas: 0, fallidas: 0 };

  const absentStudents = students.filter((student) => absentIds.has(String(student.id)));
  const tutorIds = uniqueIds(absentStudents.map((student) => student.tutor_id));
  let tutorMap = new Map();
  if (tutorIds.length) {
    const { data: tutors, error } = await supabase
      .from('tutores')
      .select('id,nombre_completo,telefono')
      .eq('academia_id', academyId)
      .in('id', tutorIds);
    if (error) throw error;
    tutorMap = new Map((tutors || []).map((tutor) => [String(tutor.id), tutor]));
  }

  const academyName = await getAcademyName(academyId);
  const formattedDate = new Date(`${training.fecha}T12:00:00`).toLocaleDateString('es-CL', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const branchLabel = branch?.nombre || branch?.disciplina || 'la rama deportiva';
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const student of absentStudents) {
    const tutor = tutorMap.get(String(student.tutor_id));
    const phone = normalizePhone(tutor?.telefono);
    if (!tutor || phone.length < 8) {
      skipped += 1;
      continue;
    }

    const message = academyMessage(academyName,
      `💙 *SEGUIMIENTO DE ASISTENCIA*\n\n` +
      `Hola ${tutor.nombre_completo || 'Apoderado/a'},\n\n` +
      `hoy registramos a *${student.nombre}* como ausente en la clase de *${category.nombre}*.\n\n` +
      `🏷️ *Rama:* ${branchLabel}\n` +
      `📅 *Fecha:* ${formattedDate}\n` +
      `⏰ *Hora:* ${training.hora || 'Sin horario informado'}\n\n` +
      `Esperamos que esté bien. Si ocurrió algún inconveniente o necesitas informarnos algo, puedes responder a este mensaje. Nos importa acompañar su proceso deportivo. 🙌`);

    try {
      await enviarMensaje(academyId, phone, message);
      sent += 1;
    } catch (error) {
      failed += 1;
      console.error(`No se pudo enviar seguimiento de ausencia para ${student.id}:`, error?.message || error);
    }
  }

  return { solicitadas: absentStudents.length, enviadas: sent, omitidas: skipped, fallidas: failed };
};

// Registro principal de una sesión. Se monta antes del router histórico/multirrama
// para conservar el mismo contrato y añadir el feedback inmediato de ausencias.
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
      return res.json({
        success: true,
        message: `Se registró la sesión para ${data.length} categorías${branchId ? ' de la rama seleccionada' : ' de la academia'}.`,
        data,
      });
    }

    const { category, branch } = await getCategoryContext(academyId, categoryId);
    if (branchId && String(branchId) !== String(category.rama_id)) {
      return res.status(409).json({ success: false, error: 'La categoría no pertenece a la rama seleccionada.', code: 'CATEGORY_BRANCH_MISMATCH' });
    }

    const rawAttendance = Array.isArray(req.body?.lista_asistencia) ? req.body.lista_asistencia : [];
    const sessionStatus = safeText(req.body?.estado, 40) || 'Realizado';
    let eligibleStudents = [];
    if (sessionStatus === 'Realizado' && rawAttendance.length) {
      const studentIds = uniqueIds(rawAttendance.map((item) => item?.jugador_id));
      eligibleStudents = await getStudentsForScope({
        academyId,
        branchId: category.rama_id,
        categoryId: category.id,
        playerIds: studentIds,
        playerSelect: 'id,nombre,tutor_id',
      });
      if (eligibleStudents.length !== studentIds.length) {
        return res.status(403).json({ success: false, error: 'La asistencia contiene un alumno ajeno a esta rama/categoría.' });
      }
    }

    const { data: training, error: trainingError } = await supabase.from('entrenamientos').insert({
      academia_id: academyId,
      categoria_id: category.id,
      sede_id: category.sede_id,
      rama_id: category.rama_id,
      fecha: date,
      hora: safeText(req.body?.hora, 20) || '17:00',
      lugar: safeText(req.body?.lugar, 300),
      estado: sessionStatus,
      es_recuperacion: req.body?.es_recuperacion === true,
      motivo_cancelacion: safeText(req.body?.motivo_cancelacion, 1000),
      clase_recuperada_id: req.body?.clase_recuperada_id || null,
      registrado_por: req.user.id,
    }).select('*').single();
    if (trainingError) throw trainingError;

    let notificationResult = { solicitadas: 0, enviadas: 0, omitidas: 0, fallidas: 0 };
    if (training.estado === 'Realizado' && rawAttendance.length) {
      const rows = rawAttendance.map((item) => ({
        entrenamiento_id: training.id,
        jugador_id: item.jugador_id,
        estado: attendanceStatus(item.estado),
        registrado_por: req.user.id,
        actualizado_at: new Date().toISOString(),
      }));
      const { error: attendanceError } = await supabase
        .from('asistencias')
        .upsert(rows, { onConflict: 'entrenamiento_id,jugador_id' });
      if (attendanceError) throw attendanceError;

      if (req.body?.notificar_ausencias !== false) {
        try {
          notificationResult = await notifyAbsences({
            academyId,
            category,
            branch,
            training,
            students: eligibleStudents,
            attendance: rawAttendance,
          });
        } catch (notificationError) {
          console.error('No se pudo completar el feedback de ausencias:', notificationError?.message || notificationError);
          notificationResult = {
            solicitadas: rawAttendance.filter((item) => attendanceStatus(item?.estado) === 'Ausente').length,
            enviadas: 0,
            omitidas: 0,
            fallidas: rawAttendance.filter((item) => attendanceStatus(item?.estado) === 'Ausente').length,
          };
        }
      }
    }

    const absenceMessage = notificationResult.solicitadas > 0
      ? ` Avisos de ausencia por WhatsApp: ${notificationResult.enviadas} enviados${notificationResult.omitidas ? `, ${notificationResult.omitidas} sin teléfono` : ''}${notificationResult.fallidas ? `, ${notificationResult.fallidas} con error` : ''}.`
      : '';

    return res.json({
      success: true,
      message: `Sesión ${training.estado.toLowerCase()} registrada.${absenceMessage}`,
      data: training,
      avisos_ausencia: notificationResult,
    });
  } catch (error) {
    console.error('Error registrando sesión con feedback familiar:', error?.message || error);
    return res.status(error?.status || 500).json({
      success: false,
      code: error?.code || undefined,
      error: error?.message || 'No fue posible registrar la sesión.',
    });
  }
});

router.get('/alumnos', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const branchId = safeText(req.query?.rama_id, 80);
    const categoryId = safeText(req.query?.categoria_id, 80);
    if (!branchId || !categoryId) {
      return res.status(400).json({ success: false, error: 'Selecciona una rama y categoría para cargar la lista.' });
    }

    const { category } = await getCategoryContext(academyId, categoryId);
    if (String(category.rama_id) !== String(branchId)) {
      return res.status(409).json({ success: false, code: 'CATEGORY_BRANCH_MISMATCH', error: 'La categoría no pertenece a la rama seleccionada.' });
    }

    // La pertenencia a categoría se resuelve mediante jugador_categoria. El
    // categoria_id de la inscripción es solo una referencia histórica y no se
    // utiliza para excluir alumnos de sus categorías adicionales.
    const students = await getStudentsForScope({
      academyId,
      branchId,
      categoryId,
      playerSelect: 'id,nombre,rut,rut_pasaporte,numero_documento,fecha_nacimiento,foto_base64,foto_url,avatar_url,alerta_medica',
    });

    const data = students.map((student) => ({
      id: student.id,
      nombre: student.nombre,
      documento: documentOf(student),
      fecha_nacimiento: student.fecha_nacimiento || null,
      foto: photoOf(student),
      rol_especialidad: student.inscripcion?.rol_especialidad || null,
      inscripcion_id: student.inscripcion?.id || null,
      rama_id: student.inscripcion?.rama_id || branchId,
      tiene_alerta_medica: Boolean(String(student.alerta_medica || '').trim()),
    }));

    return res.json({
      success: true,
      data,
      meta: {
        rama_id: branchId,
        categoria_id: categoryId,
        total: data.length,
      },
    });
  } catch (error) {
    console.error('Error cargando roster de asistencia:', error?.message || error);
    return res.status(error?.status || 500).json({
      success: false,
      code: error?.code || undefined,
      error: error?.message || 'No fue posible cargar la lista de asistencia.',
    });
  }
});

module.exports = router;
