const PDFDocument = require('pdfkit');
const { loadImageBuffer } = require('./premiumPdf');

const WHITE = '#FFFFFF';
const TEXT = '#0F172A';
const MUTED = '#64748B';
const BORDER = '#D8E0E8';
const LIGHT = '#F8FAFC';
const CURRENT = '#D4AF37';
const PREVIOUS = '#289E9D';
const SUCCESS = '#15803D';
const WARNING = '#C2410C';

const clean = (v, fallback = '-') => String(v ?? '').trim() || fallback;
const shortDate = (value) => {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString('es-CL');
};
const formatDate = shortDate;
const contentWidth = (doc) => doc.page.width - doc.page.margins.left - doc.page.margins.right;
const pageBottom = (doc) => doc.page.height - doc.page.margins.bottom;
const themeFor = (academia = {}) => ({ primary: academia.color_primario || '#102A43', accent: academia.color_secundario || CURRENT });

const toBuffer = (doc) => new Promise((resolve, reject) => {
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);
});

const brandBar = (doc, academia, title, subtitle, logo, theme) => {
  const x = doc.page.margins.left;
  const w = contentWidth(doc);
  doc.roundedRect(x, 42, w, 84, 14).fill(theme.primary);
  if (logo) {
    try { doc.image(logo, x + 14, 54, { fit: [58, 58], align: 'center', valign: 'center' }); } catch (_) {}
  }
  const textX = x + (logo ? 84 : 20);
  doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(17).text(title, textX, 59, { width: w - (textX - x) - 18 });
  doc.fillColor('#CBD5E1').font('Helvetica').fontSize(8).text(`${clean(academia.nombre, 'Academia Deportiva')} · ${subtitle}`, textX, 87, { width: w - (textX - x) - 18 });
  doc.y = 144;
};

const section = (doc, title, subtitle, theme, y = doc.y) => {
  const x = doc.page.margins.left;
  doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(10).text(title.toUpperCase(), x, y);
  if (subtitle) doc.fillColor(MUTED).font('Helvetica').fontSize(7.4).text(subtitle, x, y + 15);
  doc.y = y + (subtitle ? 34 : 24);
};

const portrait = (doc, buffer, x, y, w, h, theme) => {
  doc.roundedRect(x, y, w, h, 12).fill('#EEF2F7').strokeColor(BORDER).lineWidth(0.7).stroke();
  if (buffer) {
    try { doc.save(); doc.roundedRect(x + 3, y + 3, w - 6, h - 6, 10).clip(); doc.image(buffer, x + 3, y + 3, { fit: [w - 6, h - 6], align: 'center', valign: 'center' }); doc.restore(); return; } catch (_) {}
  }
  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7).text('SIN FOTO', x, y + h / 2 - 4, { width: w, align: 'center' });
};

const kpis = (doc, items, theme, y = doc.y) => {
  const x = doc.page.margins.left;
  const w = contentWidth(doc);
  const gap = 8;
  const boxW = (w - gap * (items.length - 1)) / items.length;
  items.forEach((item, index) => {
    const bx = x + index * (boxW + gap);
    doc.roundedRect(bx, y, boxW, 58, 10).fill(index === 1 ? '#F0FDFA' : LIGHT).strokeColor(BORDER).lineWidth(0.6).stroke();
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(6.4).text(item.label.toUpperCase(), bx + 10, y + 11, { width: boxW - 20, align: 'center' });
    doc.fillColor(index === 1 ? PREVIOUS : theme.primary).font('Helvetica-Bold').fontSize(14).text(String(item.value), bx + 8, y + 30, { width: boxW - 16, align: 'center' });
  });
  doc.y = y + 72;
};

const radarPoint = (cx, cy, radius, index, count, value = 100) => {
  const angle = -Math.PI / 2 + (Math.PI * 2 * index) / count;
  const r = radius * Math.max(0, Math.min(100, Number(value) || 0)) / 100;
  return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
};

const drawPolygon = (doc, entries, cx, cy, radius, color, values, opacity) => {
  const points = entries.map(([key], i) => radarPoint(cx, cy, radius, i, entries.length, values?.[key]));
  if (!points.length) return;
  doc.moveTo(points[0].x, points[0].y);
  points.slice(1).forEach((p) => doc.lineTo(p.x, p.y));
  doc.closePath().fillOpacity(opacity).fillAndStroke(color, color).fillOpacity(1);
  points.forEach((p) => doc.circle(p.x, p.y, 2).fill(color));
};

const dualRadar = (doc, latest, previous, latestDate, previousDate, x, y, width, height) => {
  const keys = [...new Set([...Object.keys(latest || {}), ...Object.keys(previous || {})])].slice(0, 8);
  if (keys.length < 3) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(8).text('Aún no hay suficientes métricas para construir el radar comparativo.', x, y + height / 2, { width, align: 'center' });
    return;
  }
  const entries = keys.map((k) => [k, latest?.[k]]);
  const cx = x + width / 2;
  const cy = y + height / 2 - 4;
  const radius = Math.min(width, height) * 0.29;
  [25, 50, 75, 100].forEach((level) => {
    const points = entries.map((_, i) => radarPoint(cx, cy, radius, i, entries.length, level));
    doc.moveTo(points[0].x, points[0].y); points.slice(1).forEach((p) => doc.lineTo(p.x, p.y)); doc.closePath().strokeColor('#DDE5ED').lineWidth(0.45).stroke();
  });
  entries.forEach(([label], i) => {
    const end = radarPoint(cx, cy, radius, i, entries.length, 100);
    const lp = radarPoint(cx, cy, radius + 24, i, entries.length, 100);
    doc.moveTo(cx, cy).lineTo(end.x, end.y).strokeColor('#E5EAF0').lineWidth(0.4).stroke();
    doc.fillColor('#475569').font('Helvetica-Bold').fontSize(6).text(label, lp.x - 30, lp.y - 4, { width: 60, align: 'center' });
  });
  if (previous && Object.keys(previous).length) drawPolygon(doc, entries, cx, cy, radius, PREVIOUS, previous, 0.10);
  drawPolygon(doc, entries, cx, cy, radius, CURRENT, latest, 0.14);

  const legendY = y + height - 14;
  doc.circle(x + 18, legendY, 3).fill(CURRENT); doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(6.8).text(`Actual · ${shortDate(latestDate)}`, x + 27, legendY - 4, { width: 100 });
  if (previous && Object.keys(previous).length) {
    doc.circle(x + 150, legendY, 3).fill(PREVIOUS); doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(6.8).text(`Anterior · ${shortDate(previousDate)}`, x + 159, legendY - 4, { width: 120 });
  }
};

const skillBars = (doc, latest, previous, x, y, width) => {
  let cy = y;
  Object.entries(latest || {}).slice(0, 7).forEach(([skill, raw]) => {
    const score = Math.max(0, Math.min(100, Number(raw) || 0));
    const prev = Number(previous?.[skill]);
    const delta = Number.isFinite(prev) ? score - prev : null;
    doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(7.3).text(skill, x, cy, { width: width - 58, ellipsis: true, lineBreak: false });
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7).text(`${score}/100`, x + width - 52, cy, { width: 52, align: 'right' });
    cy += 12;
    doc.roundedRect(x, cy, width, 5, 2.5).fill('#E9EEF4');
    if (Number.isFinite(prev)) doc.roundedRect(x, cy, width * Math.max(0, Math.min(100, prev)) / 100, 5, 2.5).fill(PREVIOUS);
    doc.roundedRect(x, cy, width * score / 100, 5, 2.5).fill(CURRENT);
    if (delta !== null) doc.fillColor(delta >= 0 ? SUCCESS : WARNING).font('Helvetica-Bold').fontSize(6.1).text(`${delta >= 0 ? '+' : ''}${delta} vs anterior`, x, cy + 7, { width });
    cy += 24;
  });
};

const drawMedals = async (doc, badges, x, y, width, theme) => {
  const visible = (badges || []).slice(0, 6);
  if (!visible.length) return y;
  const gap = 9;
  const cardW = (width - gap * 2) / 3;
  const rows = Math.ceil(visible.length / 3);
  const cardH = 86;
  const images = await Promise.all(visible.map((badge) => loadImageBuffer(badge.icono_url, 'badge')));
  visible.forEach((badge, i) => {
    const row = Math.floor(i / 3);
    const col = i % 3;
    const bx = x + col * (cardW + gap);
    const by = y + row * (cardH + gap);
    doc.roundedRect(bx, by, cardW, cardH, 11).fill('#FFFBEB').strokeColor('#FDE68A').lineWidth(0.6).stroke();
    if (images[i]) {
      try { doc.image(images[i], bx + 10, by + 10, { fit: [42, 42], align: 'center', valign: 'center' }); } catch (_) {}
    } else {
      doc.circle(bx + 31, by + 31, 19).fill(theme.accent);
      doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(11).text('★', bx + 18, by + 24, { width: 26, align: 'center' });
    }
    doc.fillColor('#78350F').font('Helvetica-Bold').fontSize(7.4).text(clean(badge.titulo || badge.nombre, 'Reconocimiento'), bx + 60, by + 13, { width: cardW - 70, height: 30, ellipsis: true });
    doc.fillColor(MUTED).font('Helvetica').fontSize(6.4).text(shortDate(badge.fecha_otorgado), bx + 60, by + 48, { width: cardW - 70 });
    if (badge.descripcion) doc.fillColor('#92400E').font('Helvetica').fontSize(5.8).text(clean(badge.descripcion), bx + 10, by + 62, { width: cardW - 20, height: 15, ellipsis: true, align: 'center' });
  });
  return y + rows * (cardH + gap);
};

const footer = (doc, academia, page) => {
  const x = doc.page.margins.left;
  const y = pageBottom(doc) - 12;
  doc.moveTo(x, y - 7).lineTo(doc.page.width - doc.page.margins.right, y - 7).strokeColor(BORDER).lineWidth(0.5).stroke();
  doc.fillColor('#94A3B8').font('Helvetica').fontSize(6.5).text(`${clean(academia.nombre, 'Academia Deportiva')} · Informe privado generado por Syncademia`, x, y, { width: contentWidth(doc) - 50, lineBreak: false });
  doc.text(`${page}/2`, doc.page.width - doc.page.margins.right - 40, y, { width: 40, align: 'right', lineBreak: false });
};

const average = (values = {}) => {
  const nums = Object.values(values).map(Number).filter(Number.isFinite);
  return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
};

const generatePlayerReportV2 = async ({ academia, jugador, tutor, evaluaciones = [], stats = {}, comentarios = '', badges = [], sportProfile = null }) => {
  const startedAt = Date.now();
  const theme = themeFor(academia);
  const [logo, photo] = await Promise.all([
    loadImageBuffer(academia.logo || academia.logo_url, 'logo'),
    loadImageBuffer(jugador.foto_base64 || jugador.foto_url || jugador.avatar_url, 'photo'),
  ]);
  const latestEval = evaluaciones[0] || {};
  const previousEval = evaluaciones[1] || {};
  const latest = latestEval.datos_radar || {};
  const previous = previousEval.datos_radar || {};
  const totalAttendance = (Number(stats.clases_presente) || 0) + (Number(stats.clases_ausente) || 0) + (Number(stats.clases_justificadas) || 0);
  const attendance = totalAttendance ? Math.round(((Number(stats.clases_presente) || 0) + (Number(stats.clases_justificadas) || 0)) * 100 / totalAttendance) : null;
  const disciplineLabel = clean(sportProfile?.label, 'Deporte');
  const roleLabel = clean(sportProfile?.roleLabel, 'Rol / especialidad');
  const footballStats = sportProfile?.supportsFootballStats === true;
  const doc = new PDFDocument({ size: 'A4', margin: 42, info: { Title: `Informe de evolución - ${clean(jugador.nombre, 'Alumno')}` } });
  const bufferPromise = toBuffer(doc);
  const x = doc.page.margins.left;
  const w = contentWidth(doc);
  brandBar(doc, academia, 'Informe de evolución deportiva', `${disciplineLabel} · seguimiento privado · ${shortDate(new Date())}`, logo, theme);

  const py = doc.y;
  portrait(doc, photo, x, py, 94, 108, theme);
  doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(19).text(clean(jugador.nombre).toUpperCase(), x + 114, py + 7, { width: w - 114, ellipsis: true });
  doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(9).text(`${roleLabel}: ${clean(jugador.posicion_cancha, 'Sin definir')}`, x + 114, py + 39, { width: w - 114, ellipsis: true });
  const categories = (jugador.categorias || []).map((c) => c?.nombre).filter(Boolean).join(' · ');
  doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(`Categoría: ${clean(categories, 'Sin categoría')}`, x + 114, py + 61);
  doc.text(`Nacimiento: ${formatDate(jugador.fecha_nacimiento)} · Tipo: ${clean(jugador.tipo_alumno, 'Alumno')}`, x + 114, py + 80);
  if (latestEval.created_at) doc.text(`Evaluación actual: ${shortDate(latestEval.created_at)}${previousEval.created_at ? ` · Anterior: ${shortDate(previousEval.created_at)}` : ''}`, x + 114, py + 98);
  doc.y = py + 124;

  const mainKpis = footballStats
    ? [
        { label: 'Promedio perfil', value: average(latest) === null ? '-' : `${average(latest)}/100` },
        { label: 'Asistencia', value: attendance === null ? '-' : `${attendance}%` },
        { label: 'Partidos', value: stats.partidos_jugados ?? 0 },
        { label: 'Goles + asist.', value: (Number(stats.goles) || 0) + (Number(stats.asistencias) || 0) },
      ]
    : [
        { label: 'Promedio perfil', value: average(latest) === null ? '-' : `${average(latest)}/100` },
        { label: 'Asistencia', value: attendance === null ? '-' : `${attendance}%` },
        { label: 'Evaluaciones', value: evaluaciones.length },
        { label: 'Encuentros', value: stats.partidos_jugados ?? 0 },
      ];
  kpis(doc, mainKpis, theme);

  section(doc, 'Radar comparativo', `${disciplineLabel}: evaluación actual y anterior superpuestas por color`, theme, doc.y - 2);
  const panelY = doc.y;
  const leftW = 300;
  const gap = 14;
  const rightW = w - leftW - gap;
  doc.roundedRect(x, panelY, leftW, 252, 12).fill(WHITE).strokeColor(BORDER).lineWidth(0.7).stroke();
  dualRadar(doc, latest, previous, latestEval.created_at, previousEval.created_at, x + 8, panelY + 8, leftW - 16, 230);
  doc.roundedRect(x + leftW + gap, panelY, rightW, 252, 12).fill(LIGHT).strokeColor(BORDER).lineWidth(0.7).stroke();
  doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(9).text('EVOLUCIÓN POR MÉTRICA', x + leftW + gap + 13, panelY + 14, { width: rightW - 26 });
  skillBars(doc, latest, previous, x + leftW + gap + 13, panelY + 38, rightW - 26);
  footer(doc, academia, 1);

  doc.addPage();
  brandBar(doc, academia, 'Progreso, reconocimientos y próximos focos', `${disciplineLabel} · lectura para la familia`, null, theme);
  const ranked = Object.entries(latest).map(([name, score]) => ({ name, score: Number(score) || 0 })).sort((a, b) => b.score - a.score);
  const strengths = ranked.slice(0, 3);
  const focuses = [...ranked].sort((a, b) => a.score - b.score).slice(0, 3);
  section(doc, 'Fortalezas y próximos focos', 'Lectura basada en la evaluación actual', theme);
  const colGap = 12;
  const colW = (w - colGap) / 2;
  const boxY = doc.y;
  [[x, 'FORTALEZAS', strengths, '#ECFDF5', SUCCESS], [x + colW + colGap, 'PRÓXIMOS FOCOS', focuses, '#FFF7ED', WARNING]].forEach(([bx, title, items, fill, color]) => {
    doc.roundedRect(bx, boxY, colW, 104, 11).fill(fill).strokeColor(BORDER).lineWidth(0.6).stroke();
    doc.fillColor(color).font('Helvetica-Bold').fontSize(8.6).text(title, bx + 12, boxY + 12, { width: colW - 24 });
    (items || []).forEach((item, idx) => {
      doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(7.8).text(`${idx + 1}. ${item.name}`, bx + 12, boxY + 36 + idx * 20, { width: colW - 70, ellipsis: true, lineBreak: false });
      doc.fillColor(color).font('Helvetica-Bold').fontSize(7.8).text(`${item.score}/100`, bx + colW - 56, boxY + 36 + idx * 20, { width: 44, align: 'right' });
    });
  });
  doc.y = boxY + 118;

  section(doc, 'Actividad del período', null, theme);
  const activityKpis = footballStats
    ? [
        { label: 'Presente', value: stats.clases_presente ?? 0 },
        { label: 'Ausente', value: stats.clases_ausente ?? 0 },
        { label: 'MVP', value: stats.mvp ?? 0 },
        { label: 'Goles', value: stats.goles ?? 0 },
      ]
    : [
        { label: 'Presente', value: stats.clases_presente ?? 0 },
        { label: 'Ausente', value: stats.clases_ausente ?? 0 },
        { label: 'Justificado', value: stats.clases_justificadas ?? 0 },
        { label: 'Evaluaciones', value: evaluaciones.length },
      ];
  kpis(doc, activityKpis, theme, doc.y - 4);

  if (badges.length) {
    section(doc, 'Medallas y reconocimientos', 'Últimos reconocimientos registrados por la academia', theme, doc.y - 6);
    doc.y = await drawMedals(doc, badges, x, doc.y, w, theme);
  }

  section(doc, 'Observación del cuerpo técnico', 'Mensaje preparado para la familia', theme, Math.min(doc.y + 4, 625));
  const cy = doc.y;
  doc.roundedRect(x, cy, w, 88, 12).fill(LIGHT).strokeColor(BORDER).lineWidth(0.7).stroke();
  doc.fillColor(TEXT).font('Helvetica').fontSize(8.7).text(clean(comentarios || latestEval.comentarios_profesor, 'Sin observaciones adicionales para este período.'), x + 14, cy + 14, { width: w - 28, height: 60, lineGap: 2.5, ellipsis: true });
  footer(doc, academia, 2);

  doc.end();
  const buffer = await bufferPromise;
  buffer.generationMs = Date.now() - startedAt;
  return buffer;
};

module.exports = { generatePlayerReportV2 };