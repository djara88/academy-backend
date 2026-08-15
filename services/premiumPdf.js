const PDFDocument = require('pdfkit');
const { fetchWithTimeout } = require('./httpClient');

const DEFAULT_PRIMARY = '#111827';
const DEFAULT_ACCENT = '#C8A96B';
const MUTED = '#64748B';
const LIGHT = '#F8FAFC';
const BORDER = '#E2E8F0';
const SUCCESS = '#0F766E';

const cleanText = (value, fallback = 'No informado') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const money = (value) => `$${Math.round(Number(value) || 0).toLocaleString('es-CL')}`;

const validHex = (value) => /^#[0-9a-fA-F]{6}$/.test(String(value || ''));

const academyTheme = (academia = {}) => ({
  primary: validHex(academia.color_primario) ? academia.color_primario : DEFAULT_PRIMARY,
  accent: validHex(academia.color_secundario) ? academia.color_secundario : DEFAULT_ACCENT,
});

const dataUrlToBuffer = (value) => {
  if (!value || typeof value !== 'string' || !value.startsWith('data:image/')) return null;
  const match = value.match(/^data:image\/(?:png|jpeg|jpg|webp);base64,(.+)$/i);
  if (!match) return null;
  try { return Buffer.from(match[1], 'base64'); } catch { return null; }
};

const loadImageBuffer = async (value) => {
  const inline = dataUrlToBuffer(value);
  if (inline) return inline;
  if (!value || typeof value !== 'string' || !/^https:\/\//i.test(value)) return null;
  try {
    const response = await fetchWithTimeout(value, {}, 7000);
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return null;
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > 6 * 1024 * 1024) return null;
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  }
};

const newDocument = () => new PDFDocument({ size: 'A4', margin: 42, info: { Creator: 'Syncademia' } });

const documentToBuffer = (doc) => new Promise((resolve, reject) => {
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);
});

const pageWidth = (doc) => doc.page.width;
const contentWidth = (doc) => doc.page.width - doc.page.margins.left - doc.page.margins.right;

const drawHeader = (doc, academia, title, subtitle, logoBuffer, theme) => {
  const left = doc.page.margins.left;
  const top = 34;
  doc.roundedRect(left, top, contentWidth(doc), 104, 18).fill(theme.primary);
  doc.rect(left, top + 96, contentWidth(doc), 8).fill(theme.accent);

  if (logoBuffer) {
    try { doc.image(logoBuffer, left + 18, top + 18, { fit: [70, 70], align: 'center', valign: 'center' }); } catch {}
  } else {
    doc.roundedRect(left + 18, top + 18, 70, 70, 12).fill('#FFFFFF');
    doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(11).text('ACADEMIA', left + 18, top + 46, { width: 70, align: 'center' });
  }

  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(22)
    .text(title, left + 108, top + 22, { width: contentWidth(doc) - 132, align: 'right' });
  doc.fillColor('#E5E7EB').font('Helvetica').fontSize(9)
    .text(subtitle, left + 108, top + 55, { width: contentWidth(doc) - 132, align: 'right' });
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(12)
    .text(cleanText(academia.nombre, 'Academia Deportiva').toUpperCase(), left + 108, top + 76, { width: contentWidth(doc) - 132, align: 'right' });

  doc.y = top + 126;
};

const sectionTitle = (doc, title, theme) => {
  const x = doc.page.margins.left;
  const y = doc.y + 10;
  doc.roundedRect(x, y, contentWidth(doc), 28, 8).fill(LIGHT);
  doc.rect(x, y, 5, 28).fill(theme.accent);
  doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(11).text(title.toUpperCase(), x + 14, y + 9);
  doc.y = y + 38;
};

const infoGrid = (doc, items, theme, columns = 2) => {
  const gap = 10;
  const x0 = doc.page.margins.left;
  const width = (contentWidth(doc) - gap * (columns - 1)) / columns;
  const rowHeight = 50;
  items.forEach((item, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const x = x0 + col * (width + gap);
    const y = doc.y + row * (rowHeight + 8);
    doc.roundedRect(x, y, width, rowHeight, 8).lineWidth(0.7).strokeColor(BORDER).stroke();
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5).text(String(item.label || '').toUpperCase(), x + 10, y + 9, { width: width - 20 });
    doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(10.5).text(cleanText(item.value), x + 10, y + 23, { width: width - 20, height: 22, ellipsis: true });
  });
  const rows = Math.ceil(items.length / columns);
  doc.y += rows * (rowHeight + 8) + 4;
};

const paragraph = (doc, text, options = {}) => {
  doc.fillColor(options.color || '#334155').font(options.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(options.size || 9.2)
    .text(cleanText(text, ''), { width: contentWidth(doc), align: options.align || 'left', lineGap: options.lineGap ?? 2.5 });
};

const consentBadge = (doc, label, state, theme) => {
  const accepted = state === 'aceptado';
  const x = doc.page.margins.left;
  const y = doc.y + 5;
  doc.roundedRect(x, y, contentWidth(doc), 32, 8).fill(accepted ? '#ECFDF5' : '#FFF7ED');
  doc.fillColor(accepted ? SUCCESS : '#9A3412').font('Helvetica-Bold').fontSize(9)
    .text(`${accepted ? 'AUTORIZADO' : 'NO AUTORIZADO'} · ${label}`, x + 12, y + 11, { width: contentWidth(doc) - 24 });
  doc.y = y + 38;
};

const footer = (doc, academia, pageLabel) => {
  const y = doc.page.height - 30;
  doc.moveTo(doc.page.margins.left, y - 8).lineTo(doc.page.width - doc.page.margins.right, y - 8).strokeColor(BORDER).lineWidth(0.5).stroke();
  doc.fillColor('#94A3B8').font('Helvetica').fontSize(7)
    .text(`${cleanText(academia.nombre, 'Academia Deportiva')} · Documento emitido por Syncademia · ${pageLabel}`, doc.page.margins.left, y, { width: contentWidth(doc), align: 'center' });
};

const drawPortrait = (doc, imageBuffer, x, y, width, height, theme) => {
  doc.roundedRect(x, y, width, height, 12).fill('#FFFFFF').strokeColor(BORDER).lineWidth(1).stroke();
  if (imageBuffer) {
    try { doc.image(imageBuffer, x + 4, y + 4, { fit: [width - 8, height - 8], align: 'center', valign: 'center' }); return; } catch {}
  }
  doc.fillColor('#CBD5E1').font('Helvetica-Bold').fontSize(10).text('SIN FOTO', x, y + height / 2 - 5, { width, align: 'center' });
  doc.roundedRect(x, y, width, height, 12).strokeColor(theme.accent).lineWidth(1).stroke();
};

const generateMatriculaPdf = async ({ academia, jugador, tutor, folio, consentimientos = [] }) => {
  const theme = academyTheme(academia);
  const [logoBuffer, photoBuffer] = await Promise.all([
    loadImageBuffer(academia.logo || academia.logo_url),
    loadImageBuffer(jugador.foto_base64 || jugador.foto_url || jugador.avatar_url),
  ]);

  const doc = newDocument();
  const bufferPromise = documentToBuffer(doc);
  drawHeader(doc, academia, 'MATRÍCULA OFICIAL', `Folio ${folio} · Emitido ${new Date().toLocaleDateString('es-CL')}`, logoBuffer, theme);

  const x = doc.page.margins.left;
  const photoW = 104;
  drawPortrait(doc, photoBuffer, x, doc.y + 8, photoW, 122, theme);
  const infoX = x + photoW + 18;
  doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(20).text(cleanText(jugador.nombre).toUpperCase(), infoX, doc.y + 14, { width: contentWidth(doc) - photoW - 18 });
  doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(10).text(`${cleanText(jugador.posicion_cancha, 'Posición por definir')} · ${cleanText(jugador.tipo_alumno, 'Alumno')}`, infoX, doc.y + 43);
  doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(`RUT / Documento: ${cleanText(jugador.rut || jugador.rut_pasaporte)}`, infoX, doc.y + 67);
  doc.text(`Fecha de nacimiento: ${cleanText(jugador.fecha_nacimiento)}`, infoX, doc.y + 83);
  doc.text(`Certificado médico: ${cleanText(jugador.certificado_medico, 'Pendiente')}`, infoX, doc.y + 99);
  doc.y += 144;

  sectionTitle(doc, 'Resumen de la inscripción', theme);
  infoGrid(doc, [
    { label: 'Academia', value: academia.nombre },
    { label: 'Apoderado', value: tutor.nombre_completo || tutor.nombre },
    { label: 'Teléfono', value: tutor.telefono },
    { label: 'Correo', value: tutor.email },
    { label: 'Matrícula', value: money(jugador.monto_matricula || jugador.valor_matricula) },
    { label: 'Abono inicial', value: money(jugador.abono_matricula || jugador.abono_inicial) },
    { label: 'Mensualidad', value: money(jugador.monto_mensualidad || jugador.valor_mensualidad) },
    { label: 'Saldo matrícula', value: money(Math.max(0, (Number(jugador.monto_matricula || jugador.valor_matricula) || 0) - (Number(jugador.abono_matricula || jugador.abono_inicial) || 0))) },
  ], theme, 2);

  sectionTitle(doc, 'Información práctica', theme);
  infoGrid(doc, [
    { label: 'Días de entrenamiento', value: academia.dias_entrenamiento },
    { label: 'Horarios', value: academia.horarios_entrenamiento },
    { label: 'Lugar de entrenamiento', value: academia.ubicacion_entrenamiento || academia.direccion },
    { label: 'Contacto academia', value: academia.telefono || academia.director_email || academia.correo_academia },
  ], theme, 2);

  footer(doc, academia, 'Página 1 de 3');

  doc.addPage();
  drawHeader(doc, academia, 'TÉRMINOS DE MATRÍCULA', 'Condiciones que el apoderado debe conocer y conservar', logoBuffer, theme);
  sectionTitle(doc, 'Términos y condiciones', theme);
  const terms = academia.terminos_matricula || academia.contrato_matricula || academia.terminos_condiciones || 'La academia no ha configurado términos adicionales. Se aplicarán las condiciones informadas al momento de la matrícula y la normativa vigente.';
  paragraph(doc, terms, { size: 9.5, lineGap: 4 });

  sectionTitle(doc, 'Privacidad y datos personales', theme);
  paragraph(doc, 'La información del alumno y su apoderado debe utilizarse únicamente para las finalidades informadas por la academia. Las autorizaciones de imagen son independientes de la matrícula y pueden ser rechazadas sin impedir la inscripción. Las autorizaciones registradas quedan asociadas a una versión y pueden ser revocadas para usos futuros mediante los canales oficiales de la academia.', { size: 9.2, lineGap: 3.5 });

  sectionTitle(doc, 'Canales de la academia', theme);
  infoGrid(doc, [
    { label: 'Dirección', value: academia.direccion },
    { label: 'Teléfono', value: academia.telefono || academia.telefono_director },
    { label: 'Correo responsable', value: academia.director_email || academia.correo_academia },
    { label: 'Director/a', value: academia.nombre_director || academia.director_nombre },
  ], theme, 2);
  footer(doc, academia, 'Página 2 de 3');

  doc.addPage();
  drawHeader(doc, academia, 'REGISTRO DE AUTORIZACIONES', 'Trazabilidad de privacidad asociada a esta matrícula', logoBuffer, theme);
  sectionTitle(doc, 'Decisiones registradas', theme);
  const labelMap = {
    aviso_privacidad: 'Aviso de privacidad y tratamiento operativo',
    datos_salud: 'Datos de salud y emergencia',
    imagen_interna: 'Fotografía para uso interno',
    imagen_publica: 'Fotografía / video para difusión pública',
  };
  const latest = {};
  consentimientos.forEach((item) => { if (!latest[item.tipo]) latest[item.tipo] = item; });
  Object.keys(labelMap).forEach((tipo) => consentBadge(doc, labelMap[tipo], latest[tipo]?.estado || 'rechazado', theme));

  sectionTitle(doc, 'Constancia', theme);
  paragraph(doc, `Apoderado o representante: ${cleanText(tutor.nombre_completo || tutor.nombre)}. Documento: ${cleanText(tutor.rut || tutor.rut_pasaporte)}. Las decisiones precedentes fueron registradas en el flujo de matrícula de la academia y se conservan como evidencia versionada.`, { size: 9.5, lineGap: 4 });

  doc.moveDown(3);
  const signatureY = Math.max(doc.y + 20, 565);
  doc.moveTo(x + 15, signatureY).lineTo(x + 215, signatureY).strokeColor(theme.primary).stroke();
  doc.moveTo(pageWidth(doc) - doc.page.margins.right - 215, signatureY).lineTo(pageWidth(doc) - doc.page.margins.right - 15, signatureY).strokeColor(theme.primary).stroke();
  doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(9).text('APODERADO / REPRESENTANTE', x + 15, signatureY + 8, { width: 200, align: 'center' });
  doc.text('REPRESENTANTE DE LA ACADEMIA', pageWidth(doc) - doc.page.margins.right - 215, signatureY + 8, { width: 200, align: 'center' });
  footer(doc, academia, 'Página 3 de 3');

  doc.end();
  return bufferPromise;
};

const radarPoint = (cx, cy, radius, index, count, value = 100) => {
  const angle = -Math.PI / 2 + (Math.PI * 2 * index) / count;
  const r = radius * Math.max(0, Math.min(100, Number(value) || 0)) / 100;
  return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
};

const drawRadar = (doc, values, theme, x, y, width, height) => {
  const entries = Object.entries(values || {});
  if (entries.length < 3) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(9).text('Sin evaluación suficiente para construir radar.', x, y + height / 2, { width, align: 'center' });
    return;
  }
  const cx = x + width / 2;
  const cy = y + height / 2;
  const radius = Math.min(width, height) * 0.33;
  const count = entries.length;
  [25, 50, 75, 100].forEach((level) => {
    const points = entries.map((_, i) => radarPoint(cx, cy, radius, i, count, level));
    doc.moveTo(points[0].x, points[0].y);
    points.slice(1).forEach((p) => doc.lineTo(p.x, p.y));
    doc.closePath().strokeColor(BORDER).lineWidth(0.5).stroke();
  });
  entries.forEach(([label], i) => {
    const end = radarPoint(cx, cy, radius, i, count, 100);
    const labelPt = radarPoint(cx, cy, radius + 23, i, count, 100);
    doc.moveTo(cx, cy).lineTo(end.x, end.y).strokeColor(BORDER).lineWidth(0.5).stroke();
    doc.fillColor('#475569').font('Helvetica-Bold').fontSize(6.6).text(label, labelPt.x - 30, labelPt.y - 5, { width: 60, align: 'center' });
  });
  const scorePoints = entries.map(([, value], i) => radarPoint(cx, cy, radius, i, count, value));
  doc.moveTo(scorePoints[0].x, scorePoints[0].y);
  scorePoints.slice(1).forEach((p) => doc.lineTo(p.x, p.y));
  doc.closePath().fillOpacity(0.18).fillAndStroke(theme.accent, theme.accent).fillOpacity(1);
  scorePoints.forEach((p) => doc.circle(p.x, p.y, 2.4).fill(theme.primary));
};

const generatePlayerReportPdf = async ({ academia, jugador, tutor, evaluaciones = [], stats = {}, comentarios = '' }) => {
  const theme = academyTheme(academia);
  const [logoBuffer, photoBuffer] = await Promise.all([
    loadImageBuffer(academia.logo || academia.logo_url),
    loadImageBuffer(jugador.foto_base64 || jugador.foto_url || jugador.avatar_url),
  ]);
  const latest = evaluaciones[0]?.datos_radar || {};
  const previous = evaluaciones[1]?.datos_radar || {};
  const doc = newDocument();
  const bufferPromise = documentToBuffer(doc);

  drawHeader(doc, academia, 'INFORME DE EVOLUCIÓN', `Informe privado para el apoderado · ${new Date().toLocaleDateString('es-CL')}`, logoBuffer, theme);
  const x = doc.page.margins.left;
  drawPortrait(doc, photoBuffer, x, doc.y + 8, 112, 132, theme);
  const infoX = x + 132;
  doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(23).text(cleanText(jugador.nombre).toUpperCase(), infoX, doc.y + 16, { width: contentWidth(doc) - 132 });
  doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(11).text(cleanText(jugador.posicion_cancha, 'Posición por definir'), infoX, doc.y + 50);
  doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(`Categoría: ${cleanText((jugador.categorias || []).map((c) => c.nombre).join(' · '), 'Sin categoría')}`, infoX, doc.y + 75);
  doc.text(`Nacimiento: ${cleanText(jugador.fecha_nacimiento)} · Tipo: ${cleanText(jugador.tipo_alumno)}`, infoX, doc.y + 91);
  doc.text(`Estado de certificado médico: ${cleanText(jugador.certificado_medico, 'Pendiente')}`, infoX, doc.y + 107);
  doc.y += 152;

  sectionTitle(doc, 'Indicadores del período', theme);
  infoGrid(doc, [
    { label: 'Partidos', value: stats.partidos_jugados ?? 0 },
    { label: 'Goles', value: stats.goles ?? 0 },
    { label: 'Asistencias', value: stats.asistencias ?? 0 },
    { label: 'MVP', value: stats.mvp ?? 0 },
    { label: 'Clases presente', value: stats.clases_presente ?? 0 },
    { label: 'Ausencias', value: stats.clases_ausente ?? 0 },
  ], theme, 3);

  sectionTitle(doc, 'Perfil técnico', theme);
  const radarY = doc.y;
  doc.roundedRect(x, radarY, contentWidth(doc), 245, 12).strokeColor(BORDER).lineWidth(0.8).stroke();
  drawRadar(doc, latest, theme, x + 12, radarY + 10, 330, 220);
  const listX = x + 350;
  doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(10).text('LECTURA DE HABILIDADES', listX, radarY + 18, { width: 160 });
  let metricY = radarY + 42;
  Object.entries(latest).slice(0, 8).forEach(([skill, value]) => {
    const prev = Number(previous[skill]);
    const delta = Number.isFinite(prev) ? Number(value) - prev : null;
    doc.fillColor('#475569').font('Helvetica').fontSize(8).text(skill, listX, metricY, { width: 92 });
    doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(9).text(`${value}/100`, listX + 92, metricY, { width: 48, align: 'right' });
    if (delta !== null) doc.fillColor(delta >= 0 ? SUCCESS : '#B45309').font('Helvetica-Bold').fontSize(7).text(`${delta >= 0 ? '+' : ''}${delta}`, listX + 144, metricY + 1, { width: 32, align: 'right' });
    metricY += 23;
  });
  doc.y = radarY + 258;
  footer(doc, academia, 'Página 1 de 2');

  doc.addPage();
  drawHeader(doc, academia, 'DESARROLLO Y PROYECCIÓN', 'Una lectura simple para acompañar el crecimiento deportivo', logoBuffer, theme);
  sectionTitle(doc, 'Reconocimientos', theme);
  const badges = Array.isArray(jugador.insignias) ? jugador.insignias.slice(0, 8) : [];
  if (badges.length) {
    badges.forEach((badge, index) => {
      const value = typeof badge === 'string' ? badge : badge?.nombre;
      const y = doc.y + index * 28;
      doc.roundedRect(x, y, contentWidth(doc), 22, 6).fill(index % 2 === 0 ? '#FFFBEB' : LIGHT);
      doc.fillColor('#92400E').font('Helvetica-Bold').fontSize(8.5).text(`★ ${cleanText(value)}`, x + 10, y + 7, { width: contentWidth(doc) - 20 });
    });
    doc.y += badges.length * 28 + 8;
  } else {
    paragraph(doc, 'Aún no se registran reconocimientos. El objetivo del informe es mostrar progreso, hábitos y oportunidades de desarrollo, no solo resultados competitivos.', { size: 9.5 });
  }

  sectionTitle(doc, 'Observaciones del cuerpo técnico', theme);
  doc.roundedRect(x, doc.y, contentWidth(doc), 145, 12).fill(LIGHT).strokeColor(BORDER).stroke();
  doc.fillColor('#334155').font('Helvetica').fontSize(10).text(cleanText(comentarios, 'Sin observaciones adicionales para este período.'), x + 16, doc.y + 16, { width: contentWidth(doc) - 32, height: 112, lineGap: 4 });
  doc.y += 158;

  sectionTitle(doc, 'Mensaje al apoderado', theme);
  paragraph(doc, `Gracias por confiar en ${cleanText(academia.nombre, 'nuestra academia')}. Este informe busca que la familia pueda acompañar el proceso del alumno con información clara sobre su evolución, fortalezas y próximos desafíos. El desarrollo deportivo es progresivo y debe evaluarse junto con la constancia, el bienestar y la experiencia formativa del alumno.`, { size: 10, lineGap: 4 });

  doc.moveDown(2);
  doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(10).text(cleanText(academia.nombre).toUpperCase(), { align: 'center' });
  doc.fillColor(MUTED).font('Helvetica').fontSize(8).text('Formación · Seguimiento · Confianza', { align: 'center' });
  footer(doc, academia, 'Página 2 de 2');

  doc.end();
  return bufferPromise;
};

module.exports = { generateMatriculaPdf, generatePlayerReportPdf, loadImageBuffer };
