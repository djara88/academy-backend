const PDFDocument = require('pdfkit');
const supabase = require('../config/supabase');
const { loadImageBuffer } = require('./premiumPdf');
const { resolveCompetitiveProfile, aggregateCompetitiveStats } = require('./competitiveStatsCatalog');
const { resolveEvaluationProfile, sanitizeRadarMetrics } = require('./evaluationCatalog');

const WHITE = '#FFFFFF';
const TEXT = '#0F172A';
const MUTED = '#64748B';
const BORDER = '#D8E0E8';
const LIGHT = '#F8FAFC';

// Paleta Syncademia. El layout, proporciones y composición corresponden al
// informe premium V2 histórico; solo cambia la identidad cromática.
const SYNC_DARK = '#151B25';
const SYNC_TEAL = '#289E9D';
const SYNC_GOLD = '#C8A96B';
const CURRENT = SYNC_TEAL;
const PREVIOUS = SYNC_GOLD;
const SUCCESS = '#15803D';
const WARNING = '#C2410C';

const safeText = (value, max = 1000) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const clean = (value, fallback = '-') => safeText(value, 500) || fallback;
const formatDate = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleDateString('es-CL');
};
const contentWidth = (doc) => doc.page.width - doc.page.margins.left - doc.page.margins.right;
const pageBottom = (doc) => doc.page.height - doc.page.margins.bottom;
const themeFor = () => ({ primary: SYNC_DARK, accent: SYNC_GOLD, current: SYNC_TEAL, previous: SYNC_GOLD });

const normalizeAwards = (value) => (Array.isArray(value) ? value : []).map((award, index) => {
  if (typeof award === 'string') {
    return {
      id: `legacy-${index}`,
      nombre: award,
      fecha: null,
      rama_id: null,
      descripcion: null,
      icono_url: null,
    };
  }
  if (!award || typeof award !== 'object') return null;
  return {
    ...award,
    nombre: award.nombre || award.titulo || 'Reconocimiento',
    fecha: award.fecha || award.fecha_otorgado || null,
    descripcion: award.descripcion || award.description || null,
    icono_url: award.icono_url || null,
  };
}).filter(Boolean);

const loadStudentReportData = async ({ academyId, playerId, branchId }) => {
  const { data: academy, error: academyError } = await supabase.from('academias')
    .select('id,nombre,logo_url,color_primario,color_secundario,direccion,ciudad,pais')
    .eq('id', academyId)
    .single();
  if (academyError || !academy) throw new Error('Academia no encontrada.');

  const { data: player, error: playerError } = await supabase.from('jugadores')
    .select('id,nombre,rut,rut_pasaporte,numero_documento,fecha_nacimiento,tutor_id,insignias,tipo_alumno,foto_base64,foto_url,avatar_url')
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
    compatibleEvaluations,
    attendance,
    competitive,
    awards,
  };
};

const toBuffer = (doc) => new Promise((resolve, reject) => {
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);
});

const brandBar = (doc, academy, title, subtitle, logo, theme) => {
  const x = doc.page.margins.left;
  const width = contentWidth(doc);
  doc.roundedRect(x, 42, width, 84, 14).fill(theme.primary);
  if (logo) {
    try { doc.image(logo, x + 14, 54, { fit: [58, 58], align: 'center', valign: 'center' }); } catch (_) {}
  }
  const textX = x + (logo ? 84 : 20);
  doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(17).text(title, textX, 59, { width: width - (textX - x) - 18 });
  doc.fillColor('#D8DEE8').font('Helvetica').fontSize(8).text(`${clean(academy.nombre, 'Academia Deportiva')} · ${subtitle}`, textX, 87, { width: width - (textX - x) - 18 });
  doc.y = 144;
};

const section = (doc, title, subtitle, theme, y = doc.y) => {
  const x = doc.page.margins.left;
  doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(10).text(title.toUpperCase(), x, y);
  if (subtitle) doc.fillColor(MUTED).font('Helvetica').fontSize(7.4).text(subtitle, x, y + 15);
  doc.y = y + (subtitle ? 34 : 24);
};

const portrait = (doc, buffer, x, y, width, height) => {
  doc.roundedRect(x, y, width, height, 12).fill('#EEF2F7').strokeColor(BORDER).lineWidth(0.7).stroke();
  if (buffer) {
    try {
      doc.save();
      doc.roundedRect(x + 3, y + 3, width - 6, height - 6, 10).clip();
      doc.image(buffer, x + 3, y + 3, { fit: [width - 6, height - 6], align: 'center', valign: 'center' });
      doc.restore();
      return;
    } catch (_) {}
  }
  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7).text('SIN FOTO', x, y + height / 2 - 4, { width, align: 'center' });
};

const kpis = (doc, items, theme, y = doc.y) => {
  const x = doc.page.margins.left;
  const width = contentWidth(doc);
  const gap = 8;
  const boxWidth = (width - gap * (items.length - 1)) / items.length;
  items.forEach((item, index) => {
    const bx = x + index * (boxWidth + gap);
    const highlighted = index === 1;
    doc.roundedRect(bx, y, boxWidth, 58, 10)
      .fill(highlighted ? '#EAF8F7' : LIGHT)
      .strokeColor(BORDER)
      .lineWidth(0.6)
      .stroke();
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(6.4).text(item.label.toUpperCase(), bx + 10, y + 11, { width: boxWidth - 20, align: 'center' });
    doc.fillColor(highlighted ? SYNC_TEAL : theme.primary).font('Helvetica-Bold').fontSize(14).text(String(item.value), bx + 8, y + 30, { width: boxWidth - 16, align: 'center' });
  });
  doc.y = y + 72;
};

const radarPoint = (cx, cy, radius, index, count, value = 100) => {
  const angle = -Math.PI / 2 + (Math.PI * 2 * index) / count;
  const r = radius * Math.max(0, Math.min(100, Number(value) || 0)) / 100;
  return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
};

const drawPolygon = (doc, entries, cx, cy, radius, color, values, opacity) => {
  const points = entries.map(([key], index) => radarPoint(cx, cy, radius, index, entries.length, values?.[key]));
  if (!points.length) return;
  doc.moveTo(points[0].x, points[0].y);
  points.slice(1).forEach((point) => doc.lineTo(point.x, point.y));
  doc.closePath().fillOpacity(opacity).fillAndStroke(color, color).fillOpacity(1);
  points.forEach((point) => doc.circle(point.x, point.y, 2).fill(color));
};

const dualRadar = (doc, latest, previous, latestDate, previousDate, x, y, width, height) => {
  const keys = [...new Set([...Object.keys(latest || {}), ...Object.keys(previous || {})])].slice(0, 8);
  if (keys.length < 3) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(8).text('Aún no hay suficientes métricas para construir el radar comparativo.', x, y + height / 2, { width, align: 'center' });
    return;
  }
  const entries = keys.map((key) => [key, latest?.[key]]);
  const cx = x + width / 2;
  const cy = y + height / 2 - 4;
  const radius = Math.min(width, height) * 0.29;
  [25, 50, 75, 100].forEach((level) => {
    const points = entries.map((_, index) => radarPoint(cx, cy, radius, index, entries.length, level));
    doc.moveTo(points[0].x, points[0].y);
    points.slice(1).forEach((point) => doc.lineTo(point.x, point.y));
    doc.closePath().strokeColor('#DDE5ED').lineWidth(0.45).stroke();
  });
  entries.forEach(([label], index) => {
    const end = radarPoint(cx, cy, radius, index, entries.length, 100);
    const labelPoint = radarPoint(cx, cy, radius + 24, index, entries.length, 100);
    doc.moveTo(cx, cy).lineTo(end.x, end.y).strokeColor('#E5EAF0').lineWidth(0.4).stroke();
    doc.fillColor('#475569').font('Helvetica-Bold').fontSize(6).text(label, labelPoint.x - 30, labelPoint.y - 4, { width: 60, align: 'center' });
  });
  if (previous && Object.keys(previous).length) drawPolygon(doc, entries, cx, cy, radius, PREVIOUS, previous, 0.10);
  drawPolygon(doc, entries, cx, cy, radius, CURRENT, latest, 0.14);

  const legendY = y + height - 14;
  doc.circle(x + 18, legendY, 3).fill(CURRENT);
  doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(6.8).text(`Actual · ${formatDate(latestDate)}`, x + 27, legendY - 4, { width: 100 });
  if (previous && Object.keys(previous).length) {
    doc.circle(x + 150, legendY, 3).fill(PREVIOUS);
    doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(6.8).text(`Anterior · ${formatDate(previousDate)}`, x + 159, legendY - 4, { width: 120 });
  }
};

const skillBars = (doc, latest, previous, x, y, width) => {
  let currentY = y;
  Object.entries(latest || {}).slice(0, 7).forEach(([skill, raw]) => {
    const score = Math.max(0, Math.min(100, Number(raw) || 0));
    const previousScore = Number(previous?.[skill]);
    const delta = Number.isFinite(previousScore) ? score - previousScore : null;
    doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(7.3).text(skill, x, currentY, { width: width - 58, ellipsis: true, lineBreak: false });
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7).text(`${score}/100`, x + width - 52, currentY, { width: 52, align: 'right' });
    currentY += 12;
    doc.roundedRect(x, currentY, width, 5, 2.5).fill('#E9EEF4');
    if (Number.isFinite(previousScore)) {
      doc.roundedRect(x, currentY, width * Math.max(0, Math.min(100, previousScore)) / 100, 5, 2.5).fill(PREVIOUS);
    }
    doc.roundedRect(x, currentY, width * score / 100, 5, 2.5).fill(CURRENT);
    if (delta !== null) {
      doc.fillColor(delta >= 0 ? SUCCESS : WARNING).font('Helvetica-Bold').fontSize(6.1).text(`${delta >= 0 ? '+' : ''}${delta} vs anterior`, x, currentY + 7, { width });
    }
    currentY += 24;
  });
};

const drawMedals = async (doc, badges, x, y, width, theme) => {
  const visible = (badges || []).slice(0, 6);
  if (!visible.length) return y;
  const gap = 9;
  const cardWidth = (width - gap * 2) / 3;
  const rows = Math.ceil(visible.length / 3);
  const cardHeight = 86;
  const images = await Promise.all(visible.map((badge) => loadImageBuffer(badge.icono_url, 'badge')));
  visible.forEach((badge, index) => {
    const row = Math.floor(index / 3);
    const col = index % 3;
    const bx = x + col * (cardWidth + gap);
    const by = y + row * (cardHeight + gap);
    doc.roundedRect(bx, by, cardWidth, cardHeight, 11).fill('#FBF7EE').strokeColor('#E7D7B5').lineWidth(0.6).stroke();
    if (images[index]) {
      try { doc.image(images[index], bx + 10, by + 10, { fit: [42, 42], align: 'center', valign: 'center' }); } catch (_) {}
    } else {
      doc.circle(bx + 31, by + 31, 19).fill(theme.accent);
      doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(11).text('★', bx + 18, by + 24, { width: 26, align: 'center' });
    }
    doc.fillColor('#5F4B27').font('Helvetica-Bold').fontSize(7.4).text(clean(badge.nombre, 'Reconocimiento'), bx + 60, by + 13, { width: cardWidth - 70, height: 30, ellipsis: true });
    doc.fillColor(MUTED).font('Helvetica').fontSize(6.4).text(formatDate(badge.fecha), bx + 60, by + 48, { width: cardWidth - 70 });
    if (badge.descripcion) {
      doc.fillColor('#806A3E').font('Helvetica').fontSize(5.8).text(clean(badge.descripcion), bx + 10, by + 62, { width: cardWidth - 20, height: 15, ellipsis: true, align: 'center' });
    }
  });
  return y + rows * (cardHeight + gap);
};

const footer = (doc, academy, page) => {
  const x = doc.page.margins.left;
  const y = pageBottom(doc) - 12;
  doc.moveTo(x, y - 7).lineTo(doc.page.width - doc.page.margins.right, y - 7).strokeColor(BORDER).lineWidth(0.5).stroke();
  doc.fillColor('#94A3B8').font('Helvetica').fontSize(6.5).text(`${clean(academy.nombre, 'Academia Deportiva')} · Informe privado generado por Syncademia`, x, y, { width: contentWidth(doc) - 50, lineBreak: false });
  doc.text(`${page}/2`, doc.page.width - doc.page.margins.right - 40, y, { width: 40, align: 'right', lineBreak: false });
};

const average = (values = {}) => {
  const numbers = Object.values(values).map(Number).filter(Number.isFinite);
  return numbers.length ? Math.round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length) : null;
};

const formattedMetricValue = (metric) => {
  if (!metric) return '0';
  const decimals = Number.isInteger(metric.decimals) ? metric.decimals : 0;
  const number = Number(metric.value || 0).toLocaleString('es-CL', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${number}${metric.unit ? ` ${metric.unit}` : ''}`;
};

const createStudentReportPdf = async (data, comments = '') => {
  const startedAt = Date.now();
  const theme = themeFor();
  const [logo, photo] = await Promise.all([
    loadImageBuffer(data.academy.logo_url, 'logo'),
    loadImageBuffer(data.player.foto_base64 || data.player.foto_url || data.player.avatar_url, 'photo'),
  ]);

  const latestEvaluation = data.currentEvaluation || {};
  const previousEvaluation = data.previousEvaluation || {};
  const latest = latestEvaluation.metrics || {};
  const previous = previousEvaluation.metrics || {};
  const latestDate = latestEvaluation.fecha_evaluacion || latestEvaluation.created_at;
  const previousDate = previousEvaluation.fecha_evaluacion || previousEvaluation.created_at;
  const totalAttendance = Number(data.attendance.total || 0);
  const attendancePercentage = data.attendance.porcentaje === null || data.attendance.porcentaje === undefined
    ? (totalAttendance ? Math.round(((Number(data.attendance.presente) || 0) + (Number(data.attendance.justificado) || 0)) * 100 / totalAttendance) : null)
    : data.attendance.porcentaje;
  const disciplineLabel = clean(data.evaluationProfile?.label || data.discipline, 'Deporte');
  const roleLabel = clean(data.evaluationProfile?.roleLabel, 'Rol / especialidad');
  const activityLabel = clean(data.competitive?.activityLabel, 'Participación');
  const primaryCompetitiveMetric = (data.competitive?.metrics || [])[0] || null;

  const doc = new PDFDocument({ size: 'A4', margin: 42, info: { Title: `Informe de evolución - ${clean(data.player.nombre, 'Alumno')}` } });
  const bufferPromise = toBuffer(doc);
  const x = doc.page.margins.left;
  const width = contentWidth(doc);

  // PÁGINA 1: misma composición del informe premium V2 histórico.
  brandBar(doc, data.academy, 'Informe de evolución deportiva', `${disciplineLabel} · seguimiento privado · ${formatDate(new Date())}`, logo, theme);

  const profileY = doc.y;
  portrait(doc, photo, x, profileY, 94, 108);
  doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(19).text(clean(data.player.nombre).toUpperCase(), x + 114, profileY + 7, { width: width - 114, ellipsis: true });
  doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(9).text(`${roleLabel}: ${clean(data.enrollment.rol_especialidad, 'Sin definir')}`, x + 114, profileY + 39, { width: width - 114, ellipsis: true });
  const categories = (data.categories || []).map((category) => category?.nombre).filter(Boolean).join(' · ');
  doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(`Categoría: ${clean(categories, 'Sin categoría')}`, x + 114, profileY + 61);
  doc.text(`Nacimiento: ${formatDate(data.player.fecha_nacimiento)} · Tipo: ${clean(data.player.tipo_alumno, 'Alumno')}`, x + 114, profileY + 80);
  if (latestDate) {
    doc.text(`Evaluación actual: ${formatDate(latestDate)}${previousDate ? ` · Anterior: ${formatDate(previousDate)}` : ''}`, x + 114, profileY + 98);
  }
  doc.y = profileY + 124;

  kpis(doc, [
    { label: 'Promedio perfil', value: average(latest) === null ? '-' : `${average(latest)}/100` },
    { label: 'Asistencia', value: attendancePercentage === null ? '-' : `${attendancePercentage}%` },
    { label: activityLabel, value: data.competitive?.participations ?? 0 },
    { label: 'Destacados', value: data.competitive?.mvp ?? 0 },
  ], theme);

  section(doc, 'Radar comparativo', `${disciplineLabel}: evaluación actual y anterior superpuestas por color`, theme, doc.y - 2);
  const panelY = doc.y;
  const leftWidth = 300;
  const gap = 14;
  const rightWidth = width - leftWidth - gap;
  doc.roundedRect(x, panelY, leftWidth, 252, 12).fill(WHITE).strokeColor(BORDER).lineWidth(0.7).stroke();
  dualRadar(doc, latest, previous, latestDate, previousDate, x + 8, panelY + 8, leftWidth - 16, 230);
  doc.roundedRect(x + leftWidth + gap, panelY, rightWidth, 252, 12).fill(LIGHT).strokeColor(BORDER).lineWidth(0.7).stroke();
  doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(9).text('EVOLUCIÓN POR MÉTRICA', x + leftWidth + gap + 13, panelY + 14, { width: rightWidth - 26 });
  skillBars(doc, latest, previous, x + leftWidth + gap + 13, panelY + 38, rightWidth - 26);
  footer(doc, data.academy, 1);

  // PÁGINA 2: mismas tarjetas, jerarquía y posiciones del informe histórico.
  doc.addPage();
  brandBar(doc, data.academy, 'Progreso, reconocimientos y próximos focos', `${disciplineLabel} · lectura para la familia`, null, theme);
  const ranked = Object.entries(latest).map(([name, score]) => ({ name, score: Number(score) || 0 })).sort((a, b) => b.score - a.score);
  const strengths = ranked.slice(0, 3);
  const focuses = [...ranked].sort((a, b) => a.score - b.score).slice(0, 3);
  section(doc, 'Fortalezas y próximos focos', 'Lectura basada en la evaluación actual', theme);
  const columnGap = 12;
  const columnWidth = (width - columnGap) / 2;
  const boxY = doc.y;
  [
    [x, 'FORTALEZAS', strengths, '#ECFDF5', SUCCESS],
    [x + columnWidth + columnGap, 'PRÓXIMOS FOCOS', focuses, '#FFF7ED', WARNING],
  ].forEach(([boxX, title, items, fill, color]) => {
    doc.roundedRect(boxX, boxY, columnWidth, 104, 11).fill(fill).strokeColor(BORDER).lineWidth(0.6).stroke();
    doc.fillColor(color).font('Helvetica-Bold').fontSize(8.6).text(title, boxX + 12, boxY + 12, { width: columnWidth - 24 });
    (items || []).forEach((item, index) => {
      doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(7.8).text(`${index + 1}. ${item.name}`, boxX + 12, boxY + 36 + index * 20, { width: columnWidth - 70, ellipsis: true, lineBreak: false });
      doc.fillColor(color).font('Helvetica-Bold').fontSize(7.8).text(`${item.score}/100`, boxX + columnWidth - 56, boxY + 36 + index * 20, { width: 44, align: 'right' });
    });
  });
  doc.y = boxY + 118;

  section(doc, 'Actividad del período', null, theme);
  kpis(doc, [
    { label: 'Presente', value: data.attendance.presente ?? 0 },
    { label: 'Ausente', value: data.attendance.ausente ?? 0 },
    { label: activityLabel, value: data.competitive?.participations ?? 0 },
    { label: primaryCompetitiveMetric?.label || 'Justificado', value: primaryCompetitiveMetric ? formattedMetricValue(primaryCompetitiveMetric) : (data.attendance.justificado ?? 0) },
  ], theme, doc.y - 4);

  if (data.awards.length) {
    section(doc, 'Medallas y reconocimientos', 'Últimos reconocimientos registrados por la academia', theme, doc.y - 6);
    doc.y = await drawMedals(doc, data.awards, x, doc.y, width, theme);
  }

  section(doc, 'Observación del cuerpo técnico', 'Mensaje preparado para la familia', theme, Math.min(doc.y + 4, 625));
  const commentsY = doc.y;
  doc.roundedRect(x, commentsY, width, 88, 12).fill(LIGHT).strokeColor(BORDER).lineWidth(0.7).stroke();
  doc.fillColor(TEXT).font('Helvetica').fontSize(8.7).text(
    clean(comments || latestEvaluation.comentarios_profesor, 'Sin observaciones adicionales para este período.'),
    x + 14,
    commentsY + 14,
    { width: width - 28, height: 60, lineGap: 2.5, ellipsis: true },
  );
  footer(doc, data.academy, 2);

  doc.end();
  const buffer = await bufferPromise;
  buffer.generationMs = Date.now() - startedAt;
  return buffer;
};

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
