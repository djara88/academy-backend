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
const dateRange = (month, year) => {
  const monthNumber = Math.min(12, Math.max(1, Number(month) || new Date().getMonth() + 1));
  const yearNumber = Math.min(2100, Math.max(2020, Number(year) || new Date().getFullYear()));
  const first = `${yearNumber}-${String(monthNumber).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(yearNumber, monthNumber, 0)).getUTCDate();
  return { first, last: `${yearNumber}-${String(monthNumber).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}` };
};

const duplicateAttendanceMessage = (students, duplicateIds, date) => {
  const duplicates = new Set((duplicateIds || []).map(String));
  const names = (students || [])
    .filter((student) => duplicates.has(String(student.id)))
    .map((student) => student.nombre)
    .filter(Boolean);
  const preview = names.slice(0, 3).join(', ');
  const remaining = Math.max(0, names.length - 3);
  const who = preview ? `${preview}${remaining ? ` y ${remaining} más` : ''}` : 'uno o más alumnos';
  return `La asistencia de ${who} ya fue registrada para esta rama el ${date}. No se creó una nueva sesión.`;
};

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

      // Una asistencia operativa equivale a un estado diario por alumno dentro
      // de una rama. El preflight evita crear entrenamientos huérfanos y entrega
      // un mensaje claro antes de que actúe la protección transaccional de BD.
      const { data: sameDayTrainings, error: sameDayTrainingError } = await supabase
        .from('entrenamientos')
        .select('id')
        .eq('academia_id', academyId)
        .eq('rama_id', category.rama_id)
        .eq('fecha', date)
        .eq('estado', 'Realizado');
      if (sameDayTrainingError) throw sameDayTrainingError;

      const sameDayIds = (sameDayTrainings || []).map((item) => item.id);
      if (sameDayIds.length && studentIds.length) {
        const { data: previousAttendance, error: previousAttendanceError } = await supabase
          .from('asistencias')
          .select('jugador_id')
          .in('entrenamiento_id', sameDayIds)
          .in('jugador_id', studentIds);
        if (previousAttendanceError) throw previousAttendanceError;

        const duplicateIds = uniqueIds((previousAttendance || []).map((item) => item.jugador_id));
        if (duplicateIds.length) {
          return res.status(409).json({
            success: false,
            code: 'ATTENDANCE_ALREADY_RECORDED',
            error: duplicateAttendanceMessage(eligibleStudents, duplicateIds, date),
            duplicate_player_ids: duplicateIds,
          });
        }
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
      if (attendanceError) {
        // Si dos solicitudes compiten, el trigger de BD gana. Retiramos la
        // sesión recién creada para no dejar registros vacíos/duplicados.
        try {
          await supabase.from('entrenamientos').delete().eq('id', training.id).eq('academia_id', academyId);
        } catch (cleanupError) {
          console.error('No se pudo limpiar entrenamiento tras rechazo de asistencia:', cleanupError?.message || cleanupError);
        }
        throw attendanceError;
      }

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
    const duplicateAttendance = error?.code === '23505' && /asistencia/i.test(String(error?.message || ''));
    return res.status(duplicateAttendance ? 409 : (error?.status || 500)).json({
      success: false,
      code: duplicateAttendance ? 'ATTENDANCE_ALREADY_RECORDED' : (error?.code || undefined),
      error: duplicateAttendance
        ? 'La asistencia de uno o más alumnos ya fue registrada para esta rama en la fecha seleccionada. No se creó una nueva sesión.'
        : (error?.message || 'No fue posible registrar la sesión.'),
    });
  }
});

// Métricas y detalle operativo. Este endpoint se monta antes del router histórico,
// por lo que corrige los duplicados antiguos sin eliminar trazabilidad de la BD.
router.get('/metricas', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const branchId = safeText(req.query?.rama_id, 80);
    const { first, last } = dateRange(req.query?.mes, req.query?.anio);

    let trainingQuery = supabase.from('entrenamientos')
      .select('id,categoria_id,rama_id,fecha,hora,lugar,estado,es_recuperacion,created_at,categorias(id,nombre),ramas(id,nombre,disciplina)')
      .eq('academia_id', academyId)
      .gte('fecha', first)
      .lte('fecha', last);
    if (branchId) trainingQuery = trainingQuery.eq('rama_id', branchId);

    const { data: trainings, error: trainingError } = await trainingQuery;
    if (trainingError) throw trainingError;
    const list = trainings || [];
    const trainingMap = new Map(list.map((item) => [String(item.id), item]));
    const ids = list.map((item) => item.id);

    let attendance = [];
    if (ids.length) {
      const result = await supabase.from('asistencias')
        .select('id,estado,jugador_id,entrenamiento_id,created_at,actualizado_at,jugadores(id,nombre)')
        .in('entrenamiento_id', ids);
      if (result.error) throw result.error;
      attendance = result.data || [];
    }

    // Sesiones repetidas por reenvíos históricos se cuentan una sola vez por
    // rama + categoría + fecha + tipo de sesión, conservando la más reciente.
    const uniqueSessionMap = new Map();
    for (const training of list) {
      const sessionKey = [
        training.estado || '',
        training.rama_id || '',
        training.categoria_id || '',
        training.fecha || '',
        training.es_recuperacion ? 'REC' : 'REG',
      ].join('|');
      const previous = uniqueSessionMap.get(sessionKey);
      const currentTime = Date.parse(training.created_at || `${training.fecha}T00:00:00Z`) || 0;
      const previousTime = previous ? (Date.parse(previous.created_at || `${previous.fecha}T00:00:00Z`) || 0) : -1;
      if (!previous || currentTime >= previousTime) uniqueSessionMap.set(sessionKey, training);
    }
    const uniqueSessions = [...uniqueSessionMap.values()];

    // La unidad de asistencia es alumno + rama + fecha. Para datos históricos
    // duplicados se conserva el registro más reciente, sin borrar los originales.
    const effectiveAttendanceMap = new Map();
    for (const item of attendance) {
      const training = trainingMap.get(String(item.entrenamiento_id));
      if (!training || training.estado !== 'Realizado' || !item.jugador_id) continue;
      const attendanceKey = `${item.jugador_id}|${training.rama_id || ''}|${training.fecha || ''}`;
      const currentTimestamp = item.actualizado_at || item.created_at || training.created_at || `${training.fecha}T00:00:00Z`;
      const previous = effectiveAttendanceMap.get(attendanceKey);
      const previousTimestamp = previous?.timestamp || '';
      if (!previous || Date.parse(currentTimestamp) >= Date.parse(previousTimestamp)) {
        effectiveAttendanceMap.set(attendanceKey, { item, training, timestamp: currentTimestamp });
      }
    }

    const catStats = new Map();
    const studentStats = new Map();
    let presentes = 0;
    let ausentes = 0;
    let justificados = 0;
    const detail = [];

    for (const { item, training, timestamp } of effectiveAttendanceMap.values()) {
      const state = attendanceStatus(item.estado);
      if (state === 'Presente') presentes += 1;
      else if (state === 'Ausente') ausentes += 1;
      else if (state === 'Justificado') justificados += 1;

      if (training.categoria_id) {
        const current = catStats.get(String(training.categoria_id)) || {
          nombre: training.categorias?.nombre || 'Categoría',
          presentes: 0,
          total: 0,
        };
        current.total += 1;
        if (state === 'Presente') current.presentes += 1;
        catStats.set(String(training.categoria_id), current);
      }

      if (item.jugador_id && item.jugadores) {
        const current = studentStats.get(String(item.jugador_id)) || {
          nombre: item.jugadores.nombre,
          presentes: 0,
          total: 0,
        };
        current.total += 1;
        if (state === 'Presente') current.presentes += 1;
        studentStats.set(String(item.jugador_id), current);
      }

      detail.push({
        registro_id: item.id,
        entrenamiento_id: training.id,
        fecha: training.fecha,
        hora: training.hora || '',
        registrado_at: timestamp || null,
        alumno: item.jugadores?.nombre || 'Alumno',
        jugador_id: item.jugador_id,
        estado: state,
        categoria: training.categorias?.nombre || 'Categoría',
        rama: training.ramas?.nombre || '',
        disciplina: training.ramas?.disciplina || '',
        lugar: training.lugar || '',
        es_recuperacion: Boolean(training.es_recuperacion),
      });
    }

    detail.sort((a, b) => {
      const byDate = String(b.fecha || '').localeCompare(String(a.fecha || ''));
      if (byDate !== 0) return byDate;
      const byTime = String(b.hora || '').localeCompare(String(a.hora || ''));
      if (byTime !== 0) return byTime;
      return String(b.registrado_at || '').localeCompare(String(a.registrado_at || ''));
    });

    const totalRecords = presentes + ausentes + justificados;
    const categories = [...catStats.values()]
      .map((item) => ({ ...item, porcentaje: item.total ? Math.round((item.presentes / item.total) * 100) : 0 }))
      .sort((a, b) => b.porcentaje - a.porcentaje || b.presentes - a.presentes);
    const students = [...studentStats.values()]
      .map((item) => ({ ...item, porcentaje: item.total ? Math.round((item.presentes / item.total) * 100) : 0 }))
      .sort((a, b) => b.porcentaje - a.porcentaje || b.presentes - a.presentes || a.nombre.localeCompare(b.nombre, 'es'));

    return res.json({
      success: true,
      data: {
        global: {
          totalClases: uniqueSessions.filter((item) => item.estado === 'Realizado').length,
          canceladas: uniqueSessions.filter((item) => item.estado === 'Cancelado').length,
          recuperativas: uniqueSessions.filter((item) => item.es_recuperacion).length,
          porcentajeGlobal: totalRecords ? Math.round((presentes / totalRecords) * 100) : 0,
          totalPresentes: presentes,
          totalAusentes: ausentes,
          totalJustificados: justificados,
        },
        categorias: categories,
        jugadores: students,
        registros: detail,
        rama_id: branchId || null,
        periodo: { desde: first, hasta: last },
      },
    });
  } catch (error) {
    console.error('Error cargando métricas operativas de asistencia:', error?.message || error);
    return res.status(500).json({ success: false, error: error?.message || 'No fue posible cargar métricas.' });
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
