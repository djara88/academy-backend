const PDFDocument = require('pdfkit');
const supabase = require('../config/supabase');
const { resolveCompetitiveProfile, aggregateCompetitiveStats } = require('./competitiveStatsCatalog');
const { resolveEvaluationProfile, sanitizeRadarMetrics } = require('./evaluationCatalog');

const safeText = (value, max = 1000) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const formatDate = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
};

const normalizeAwards = (value) => (Array.isArray(value) ? value : []).map((award, index) => {
  if (typeof award === 'string') return { id: `legacy-${index}`, nombre: award, fecha: null, rama_id: null };
  return award && typeof award === 'object' ? award : null;
}).filter(Boolean);

const loadStudentReportData = async ({ academyId, playerId, branchId }) => {
  const { data: academy, error: academyError } = await supabase.from('academias')
    .select('id,nombre,logo_url,color_primario,color_secundario,direccion,ciudad,pais')
    .eq('id', academyId)
    .single();
  if (academyError || !academy) throw new Error('Academia no encontrada.');

  const { data: player, error: playerError } = await supabase.from('jugadores')
    .select('id,nombre,rut,rut_pasaporte,numero_documento,fecha_nacimiento,tutor_id,insignias')
    .eq('id', playerId)
    .eq('academia_id', academyId)
    .maybeSingle();
  if (playerError) throw playerError;
  if (!player) {
    const error = new Error('Alumno no encontrado.');
    error.statusCode = 404;
    throw error;
  }

  let enrollmentQuery = supabase.from('inscripciones_deportivas')
    .select('id,sede_id,rama_id,categoria_id,estado,fecha_inicio,es_principal,rol_especialidad,ramas(id,nombre,disciplina,config_evaluacion),sedes(id,nombre)')
    .eq('academia_id', academyId)
    .eq('jugador_id', playerId)
    .order('es_principal', { ascending: false })
    .order('created_at', { ascending: true });
  if (branchId) enrollmentQuery = enrollmentQuery.eq('rama_id', branchId);
  const { data: enrollments, error: enrollmentError } = await enrollmentQuery;
  if (enrollmentError) throw enrollmentError;
  const enrollment = (enrollments || []).find((row) => row.estado === 'Activa') || (enrollments || [])[0] || null;
  if (!enrollment) {
    const error = new Error('El alumno no tiene una inscripción en la rama seleccionada.');
    error.statusCode = 404;
    throw error;
  }

  const discipline = enrollment.ramas?.disciplina || enrollment.ramas?.nombre || 'Deporte';
  const evaluationProfile = resolveEvaluationProfile({
    discipline,
    role: enrollment.rol_especialidad || '',
    customConfig: enrollment.ramas?.config_evaluacion || {},
    scopeId: enrollment.rama_id,
  });

  const [categoryResult, evaluationResult, tutorResult, trainingResult, matchResult] = await Promise.all([
    supabase.from('jugador_categoria')
      .select('categoria_id,categorias(id,nombre,rama_id)')
      .eq('jugador_id', playerId),
    supabase.from('evaluaciones')
      .select('id,datos_radar,comentarios_profesor,fecha_evaluacion,created_at,perfil_evaluacion,metricas_version')
      .eq('academia_id', academyId)
      .eq('jugador_id', playerId)
      .eq('rama_id', enrollment.rama_id)
      .order('created_at', { ascending: false })
      .limit(20),
    player.tutor_id
      ? supabase.from('tutores').select('id,nombre_completo,nombre,email,telefono').eq('id', player.tutor_id).eq('academia_id', academyId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase.from('entrenamientos').select('id').eq('academia_id', academyId).eq('rama_id', enrollment.rama_id),
    supabase.from('partidos').select('id').eq('academia_id', academyId).eq('rama_id', enrollment.rama_id),
  ]);
  for (const result of [categoryResult, evaluationResult, tutorResult, trainingResult, matchResult]) if (result.error) throw result.error;

  const categories = (categoryResult.data || [])
    .map((row) => row.categorias)
    .filter((category) => category && String(category.rama_id || '') === String(enrollment.rama_id));

  const compatibleEvaluations = (evaluationResult.data || []).map((row) => ({
    ...row,
    metrics: sanitizeRadarMetrics(row.datos_radar || {}, evaluationProfile.metrics),
  })).filter((row) => {
    if (Object.keys(row.metrics).length !== evaluationProfile.metrics.length) return false;
    if (!row.perfil_evaluacion) return true;
    return row.perfil_evaluacion === evaluationProfile.profileCode
      && Number(row.metricas_version || 1) === Number(evaluationProfile.metricVersion);
  });

  const trainingIds = (trainingResult.data || []).map((row) => row.id);
  let attendanceRows = [];
  if (trainingIds.length) {
    const { data, error } = await supabase.from('asistencias')
      .select('estado')
      .eq('jugador_id', playerId)
      .in('entrenamiento_id', trainingIds);
    if (error) throw error;
    attendanceRows = data || [];
  }
  const attendance = { total: 0, presente: 0, ausente: 0, justificado: 0, porcentaje: null };
  for (const row of attendanceRows) {
    const state = safeText(row.estado, 40).toLowerCase();
    attendance.total += 1;
    if (state === 'presente') attendance.presente += 1;
    else if (state === 'ausente') attendance.ausente += 1;
    else if (state === 'justificado') attendance.justificado += 1;
  }
  const considered = attendance.presente + attendance.ausente + attendance.justificado;
  attendance.porcentaje = considered ? Math.round(((attendance.presente + attendance.justificado) / considered) * 100) : null;

  const matchIds = (matchResult.data || []).map((row) => row.id);
  let competitiveRows = [];
  if (matchIds.length) {
    const { data, error } = await supabase.from('partido_estadisticas')
      .select('partido_id,disciplina_codigo,metricas_competitivas,metricas_version,goles,asistencias,tarjetas_amarillas,tarjetas_rojas,es_mvp,created_at')
      .eq('jugador_id', playerId)
      .in('partido_id', matchIds)
      .order('created_at', { ascending: false });
    if (error) throw error;
    competitiveRows = data || [];
  }
  const competitiveProfile = resolveCompetitiveProfile({ discipline });
  const competitive = aggregateCompetitiveStats(competitiveProfile, competitiveRows);

  const awards = normalizeAwards(player.insignias)
    .filter((award) => !award.rama_id || String(award.rama_id) === String(enrollment.rama_id))
    .slice(0, 20);

  return {
    academy,
    player,
    tutor: tutorResult.data || null,
    enrollment,
    categories,
    discipline,
    evaluationProfile,
    currentEvaluation: compatibleEvaluations[0] || null,
    previousEvaluation: compatibleEvaluations[1] || null,
    attendance,
    competitive,
    awards,
  };
};

const createStudentReportPdf = async (data, comments = '') => new Promise((resolve, reject) => {
  try {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 42, bottom: 44, left: 46, right: 46 }, info: { Title: `Informe de evolución - ${data.player.nombre}` } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const teal = '#168B8A';
    const dark = '#17212B';
    const gray = '#64748B';
    const light = '#F1F5F9';
    const gold = '#B38A3E';
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    const sectionTitle = (title) => {
      if (doc.y > 700) doc.addPage();
      doc.moveDown(0.7);
      doc.font('Helvetica-Bold').fontSize(12).fillColor(dark).text(title);
      doc.moveTo(doc.page.margins.left, doc.y + 4).lineTo(doc.page.margins.left + pageWidth, doc.y + 4).strokeColor('#D7DEE7').stroke();
      doc.moveDown(0.55);
    };
    const keyValue = (label, value) => {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(gray).text(`${label}: `, { continued: true });
      doc.font('Helvetica').fillColor(dark).text(safeText(value, 250) || '-');
    };

    doc.roundedRect(doc.page.margins.left, 34, pageWidth, 84, 12).fill(teal);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(21).text(data.academy.nombre, 62, 52, { width: pageWidth - 32 });
    doc.font('Helvetica').fontSize(10).text('Informe de evolución del alumno', 62, 81);
    doc.fontSize(8).text(`Emitido el ${formatDate(new Date().toISOString())}`, 62, 99);
    doc.y = 138;

    doc.roundedRect(doc.page.margins.left, doc.y, pageWidth, 82, 10).fill(light);
    const startY = doc.y + 13;
    doc.fillColor(dark).font('Helvetica-Bold').fontSize(16).text(data.player.nombre, 60, startY);
    doc.font('Helvetica').fontSize(9).fillColor(gray).text([
      data.discipline,
      data.enrollment.ramas?.nombre && data.enrollment.ramas.nombre !== data.discipline ? data.enrollment.ramas.nombre : '',
      data.enrollment.sedes?.nombre || '',
    ].filter(Boolean).join(' · '), 60, startY + 25);
    doc.text(`Categorías: ${data.categories.length ? data.categories.map((item) => item.nombre).join(', ') : 'Sin categoría asignada'}`, 60, startY + 42);
    doc.text(`Rol / especialidad: ${data.enrollment.rol_especialidad || 'Sin definir'}`, 60, startY + 57);
    doc.y = startY + 83;

    sectionTitle('Resumen de asistencia');
    const attendanceText = data.attendance.porcentaje === null
      ? 'Sin registros de asistencia en esta rama.'
      : `${data.attendance.porcentaje}% de cumplimiento · ${data.attendance.presente} presente(s) · ${data.attendance.justificado} justificada(s) · ${data.attendance.ausente} ausente(s)`;
    doc.font('Helvetica').fontSize(10).fillColor(dark).text(attendanceText);

    sectionTitle(`Evaluación de aptitudes · ${data.evaluationProfile.label}`);
    if (!data.currentEvaluation) {
      doc.font('Helvetica').fontSize(10).fillColor(gray).text('Aún no existe una evaluación compatible registrada para esta rama y perfil.');
    } else {
      for (const metric of data.evaluationProfile.metrics) {
        const current = Number(data.currentEvaluation.metrics[metric] || 0);
        const previous = data.previousEvaluation ? Number(data.previousEvaluation.metrics[metric] || 0) : null;
        const x = doc.page.margins.left;
        const y = doc.y;
        doc.font('Helvetica').fontSize(8.5).fillColor(dark).text(metric, x, y, { width: 190 });
        doc.roundedRect(x + 195, y + 1, 210, 8, 4).fill('#DCE5EA');
        doc.roundedRect(x + 195, y + 1, 210 * Math.max(0, Math.min(100, current)) / 100, 8, 4).fill(teal);
        doc.font('Helvetica-Bold').fillColor(dark).text(`${current}/100`, x + 414, y - 1, { width: 55, align: 'right' });
        if (previous !== null) doc.font('Helvetica').fontSize(7.5).fillColor(gray).text(`Anterior: ${previous}`, x + 414, y + 11, { width: 55, align: 'right' });
        doc.y = y + (previous !== null ? 25 : 20);
        if (doc.y > 705) doc.addPage();
      }
      const evalComment = safeText(data.currentEvaluation.comentarios_profesor, 1800);
      if (evalComment) {
        doc.moveDown(0.3);
        doc.font('Helvetica-Bold').fontSize(9).fillColor(gray).text('Observación de la última evaluación');
        doc.font('Helvetica').fontSize(9).fillColor(dark).text(evalComment, { lineGap: 2 });
      }
    }

    sectionTitle(`Rendimiento competitivo · ${data.competitive.label}`);
    keyValue(data.competitive.activityLabel === 'Partido' ? 'Partidos registrados' : 'Participaciones registradas', data.competitive.participations);
    for (const metric of data.competitive.metrics || []) {
      const decimals = Number.isInteger(metric.decimals) ? metric.decimals : 0;
      const value = Number(metric.value || 0).toLocaleString('es-CL', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      keyValue(metric.label, `${value}${metric.unit ? ` ${metric.unit}` : ''}`);
    }

    sectionTitle('Reconocimientos');
    if (!data.awards.length) doc.font('Helvetica').fontSize(10).fillColor(gray).text('Aún no hay reconocimientos registrados para esta rama.');
    else {
      for (const award of data.awards.slice(0, 12)) {
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(gold).text(`• ${safeText(award.nombre, 120)}`, { continued: true });
        doc.font('Helvetica').fillColor(gray).text(`  ${formatDate(award.fecha)}`);
      }
    }

    const finalComments = safeText(comments, 2500);
    if (finalComments) {
      sectionTitle('Comentario final para la familia');
      doc.roundedRect(doc.page.margins.left, doc.y, pageWidth, Math.max(70, doc.heightOfString(finalComments, { width: pageWidth - 28 }) + 28), 9).fill('#FFF8E8');
      doc.fillColor(dark).font('Helvetica').fontSize(10).text(finalComments, doc.page.margins.left + 14, doc.y + 14, { width: pageWidth - 28, lineGap: 3 });
      doc.moveDown(1.2);
    }

    if (doc.y > 720) doc.addPage();
    doc.moveDown(1);
    doc.font('Helvetica').fontSize(8).fillColor(gray).text(
      `Este informe resume información deportiva registrada en ${data.academy.nombre} para la rama ${data.discipline}. No incluye información financiera ni antecedentes médicos sensibles.`,
      { align: 'center', lineGap: 2 },
    );
    doc.end();
  } catch (error) {
    reject(error);
  }
});

const sendStudentReportEmail = async ({ data, pdfBuffer, comments }) => {
  const email = safeText(data.tutor?.email, 220);
  if (!email) return { sent: false, reason: 'El apoderado no tiene correo registrado.' };
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!apiKey || !senderEmail) return { sent: false, reason: 'El servicio de correo no está configurado.' };

  const tutorName = safeText(data.tutor?.nombre_completo || data.tutor?.nombre, 120) || 'Apoderado/a';
  const safeComments = safeText(comments, 1800);
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { accept: 'application/json', 'api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: { name: data.academy.nombre, email: senderEmail },
      to: [{ email, name: tutorName }],
      subject: `${data.academy.nombre} | Informe de evolución - ${data.player.nombre} · ${data.discipline}`,
      htmlContent: `<div style="font-family:Arial,sans-serif;color:#24303b;line-height:1.55"><h2>Hola ${tutorName},</h2><p>Adjuntamos el informe de evolución de <strong>${safeText(data.player.nombre, 120)}</strong> correspondiente a <strong>${safeText(data.discipline, 100)}</strong>.</p>${safeComments ? `<p><strong>Comentario de la academia:</strong><br>${safeComments}</p>` : ''}<p>Saludos,<br><strong>${safeText(data.academy.nombre, 120)}</strong></p></div>`,
      attachment: [{ name: `Informe_${safeText(data.player.nombre, 80).replace(/[^a-zA-Z0-9_-]+/g, '_')}_${safeText(data.discipline, 60).replace(/[^a-zA-Z0-9_-]+/g, '_')}.pdf`, content: pdfBuffer.toString('base64') }],
    }),
  });
  if (!response.ok) return { sent: false, reason: `Brevo respondió HTTP ${response.status}.` };
  return { sent: true, reason: null };
};

module.exports = {
  loadStudentReportData,
  createStudentReportPdf,
  sendStudentReportEmail,
};
