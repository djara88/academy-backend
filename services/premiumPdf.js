const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const crypto = require('crypto');
const { fetchWithTimeout } = require('./httpClient');

const DEFAULT_PRIMARY = '#0F172A';
const DEFAULT_ACCENT = '#C6A15B';
const TEXT = '#172033';
const MUTED = '#64748B';
const LIGHT = '#F8FAFC';
const BORDER = '#D9E2EC';
const SUCCESS = '#087F5B';
const WARNING = '#B45309';
const WHITE = '#FFFFFF';
const imageCache = new Map();
const IMAGE_CACHE_TTL_MS = 15 * 60 * 1000;
const IMAGE_CACHE_MAX = 80;

const cleanText = (value, fallback = 'No informado') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const optionalText = (value) => {
  const text = String(value ?? '').trim();
  return text || null;
};

const money = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '-';
  return `$${Math.round(numeric).toLocaleString('es-CL')}`;
};

const formatDate = (value, fallback = '-') => {
  if (!value) return fallback;
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return cleanText(value, fallback);
  return new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: 'long', year: 'numeric' }).format(date);
};

const shortDate = (value, fallback = '-') => {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
};

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

const cacheKeyFor = (value, kind) => {
  if (!value || typeof value !== 'string') return null;
  if (/^https:\/\//i.test(value)) return `${kind}:url:${value}`;
  return `${kind}:data:${crypto.createHash('sha1').update(value).digest('hex')}`;
};

const pruneImageCache = () => {
  const now = Date.now();
  for (const [key, entry] of imageCache.entries()) {
    if (now - entry.createdAt > IMAGE_CACHE_TTL_MS) imageCache.delete(key);
  }
  while (imageCache.size > IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
};

const optimizeImage = async (buffer, kind = 'photo') => {
  if (!buffer?.length) return null;
  try {
    const pipeline = sharp(buffer, { failOn: 'none' }).rotate();
    if (kind === 'logo') {
      return await pipeline
        .resize(260, 260, { fit: 'inside', withoutEnlargement: true })
        .png({ compressionLevel: 9, palette: true, quality: 90 })
        .toBuffer();
    }
    return await pipeline
      .resize(520, 640, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#FFFFFF' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
  } catch {
    return buffer.length <= 900 * 1024 ? buffer : null;
  }
};

const loadImageBuffer = async (value, kind = 'photo') => {
  if (!value || typeof value !== 'string') return null;
  const key = cacheKeyFor(value, kind);
  pruneImageCache();
  const cached = key ? imageCache.get(key) : null;
  if (cached && Date.now() - cached.createdAt <= IMAGE_CACHE_TTL_MS) return cached.buffer;

  let raw = dataUrlToBuffer(value);
  if (!raw && /^https:\/\//i.test(value)) {
    try {
      const response = await fetchWithTimeout(value, {}, 5000);
      if (!response.ok) return null;
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) return null;
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > 6 * 1024 * 1024) return null;
      raw = Buffer.from(arrayBuffer);
    } catch {
      return null;
    }
  }
  if (!raw) return null;

  const optimized = await optimizeImage(raw, kind);
  if (optimized && key) imageCache.set(key, { buffer: optimized, createdAt: Date.now() });
  return optimized;
};

const newDocument = (title) => new PDFDocument({
  size: 'A4',
  margin: 36,
  compress: true,
  info: { Creator: 'Syncademia', Producer: 'Syncademia', Title: title },
});

const documentToBuffer = (doc) => new Promise((resolve, reject) => {
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);
});

const contentWidth = (doc) => doc.page.width - doc.page.margins.left - doc.page.margins.right;
const pageBottom = (doc) => doc.page.height - doc.page.margins.bottom;

const drawBrandBar = (doc, academia, title, kicker, logoBuffer, theme, options = {}) => {
  const x = doc.page.margins.left;
  const y = options.y || 30;
  const w = contentWidth(doc);
  const h = options.compact ? 72 : 92;
  doc.roundedRect(x, y, w, h, 18).fill(theme.primary);
  doc.roundedRect(x, y + h - 6, w, 6, 3).fill(theme.accent);

  if (logoBuffer) {
    try {
      const size = options.compact ? 48 : 62;
      const imageY = y + (h - size) / 2 - 2;
      doc.roundedRect(x + 16, imageY - 2, size + 4, size + 4, 10).fill(WHITE);
      doc.image(logoBuffer, x + 18, imageY, { fit: [size, size], align: 'center', valign: 'center' });
    } catch {}
  }

  const textX = x + (logoBuffer ? (options.compact ? 80 : 96) : 20);
  doc.fillColor('#CBD5E1').font('Helvetica-Bold').fontSize(7.5)
    .text(cleanText(kicker, 'DOCUMENTO INSTITUCIONAL').toUpperCase(), textX, y + 17, { characterSpacing: 1.1 });
  doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(options.compact ? 18 : 22)
    .text(title, textX, y + 31, { width: w - (textX - x) - 18, ellipsis: true });
  doc.fillColor('#E2E8F0').font('Helvetica').fontSize(8.5)
    .text(cleanText(academia.nombre, 'Academia Deportiva'), textX, y + (options.compact ? 54 : 64), { width: w - (textX - x) - 18, ellipsis: true });
  doc.y = y + h + 14;
};

const drawSectionHeading = (doc, title, subtitle, theme, y = doc.y) => {
  const x = doc.page.margins.left;
  doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(12).text(title, x, y, { width: contentWidth(doc) });
  if (subtitle) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(7.8).text(subtitle, x, y + 17, { width: contentWidth(doc) });
    doc.y = y + 35;
  } else {
    doc.y = y + 23;
  }
  doc.moveTo(x, doc.y - 5).lineTo(x + contentWidth(doc), doc.y - 5).strokeColor(BORDER).lineWidth(0.7).stroke();
};

const drawPortrait = (doc, imageBuffer, x, y, width, height, theme) => {
  doc.roundedRect(x, y, width, height, 14).fill('#F8FAFC').strokeColor(BORDER).lineWidth(0.8).stroke();
  if (imageBuffer) {
    try {
      doc.save();
      doc.roundedRect(x + 3, y + 3, width - 6, height - 6, 11).clip();
      doc.image(imageBuffer, x + 3, y + 3, { cover: [width - 6, height - 6], align: 'center', valign: 'center' });
      doc.restore();
      return;
    } catch {}
  }
  doc.fillColor('#94A3B8').font('Helvetica-Bold').fontSize(9).text('SIN FOTO', x, y + height / 2 - 5, { width, align: 'center' });
  doc.roundedRect(x, y, width, height, 14).strokeColor(theme.accent).lineWidth(1).stroke();
};

const drawDataRows = (doc, items, theme, options = {}) => {
  const x = options.x ?? doc.page.margins.left;
  const y = options.y ?? doc.y;
  const width = options.width ?? contentWidth(doc);
  const columns = options.columns || 2;
  const gap = options.gap ?? 10;
  const filtered = items.filter((item) => item.value !== null && item.value !== undefined && String(item.value).trim() !== '');
  const colWidth = (width - gap * (columns - 1)) / columns;
  const rowHeight = options.rowHeight || 46;
  const rows = Math.max(1, Math.ceil(filtered.length / columns));
  const baseY = y;

  filtered.forEach((item, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const bx = x + col * (colWidth + gap);
    const by = baseY + row * (rowHeight + 8);
    doc.roundedRect(bx, by, colWidth, rowHeight, 9).fill(options.fill || WHITE).strokeColor(BORDER).lineWidth(0.65).stroke();
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(6.8)
      .text(String(item.label || '').toUpperCase(), bx + 10, by + 8, { width: colWidth - 20, ellipsis: true, lineBreak: false });
    doc.fillColor(item.emphasis ? theme.accent : TEXT).font('Helvetica-Bold').fontSize(item.emphasis ? 12.5 : 9.7)
      .text(cleanText(item.value, '-'), bx + 10, by + 22, { width: colWidth - 20, height: rowHeight - 26, ellipsis: true, lineBreak: false });
  });
  doc.y = baseY + rows * (rowHeight + 8);
};

const drawKpiRow = (doc, items, theme, y = doc.y) => {
  const x = doc.page.margins.left;
  const gap = 8;
  const width = (contentWidth(doc) - gap * (items.length - 1)) / items.length;
  items.forEach((item, index) => {
    const bx = x + index * (width + gap);
    doc.roundedRect(bx, y, width, 64, 12).fill(index === 0 ? theme.primary : LIGHT).strokeColor(index === 0 ? theme.primary : BORDER).stroke();
    doc.fillColor(index === 0 ? '#CBD5E1' : MUTED).font('Helvetica-Bold').fontSize(6.8)
      .text(String(item.label).toUpperCase(), bx + 10, y + 10, { width: width - 20, align: 'center' });
    doc.fillColor(index === 0 ? WHITE : (item.accent ? theme.accent : TEXT)).font('Helvetica-Bold').fontSize(17)
      .text(cleanText(item.value, '-'), bx + 8, y + 29, { width: width - 16, align: 'center', ellipsis: true, lineBreak: false });
  });
  doc.y = y + 76;
};

const drawConsentRows = (doc, consentimientos, theme, y = doc.y) => {
  const labels = {
    aviso_privacidad: 'Tratamiento de datos para gestión de la matrícula',
    datos_salud: 'Información mínima de salud y emergencia',
    imagen_interna: 'Fotografía para identificación e informes internos',
    imagen_publica: 'Fotografía o video para difusión pública',
  };
  const latest = {};
  (consentimientos || []).forEach((item) => { if (item?.tipo && !latest[item.tipo]) latest[item.tipo] = item; });
  let currentY = y;
  Object.entries(labels).forEach(([tipo, label]) => {
    const accepted = latest[tipo]?.estado === 'aceptado';
    doc.roundedRect(doc.page.margins.left, currentY, contentWidth(doc), 34, 8).fill(accepted ? '#ECFDF5' : '#FFF7ED');
    doc.circle(doc.page.margins.left + 18, currentY + 17, 7).fill(accepted ? SUCCESS : WARNING);
    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(8).text(accepted ? '✓' : '–', doc.page.margins.left + 14.4, currentY + 12.2, { width: 8, align: 'center' });
    doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(8.4).text(label, doc.page.margins.left + 34, currentY + 8, { width: contentWidth(doc) - 155 });
    doc.fillColor(accepted ? SUCCESS : WARNING).font('Helvetica-Bold').fontSize(7.2)
      .text(accepted ? 'AUTORIZADO' : 'NO AUTORIZADO', doc.page.width - doc.page.margins.right - 105, currentY + 12, { width: 92, align: 'right' });
    currentY += 41;
  });
  doc.y = currentY + 2;
};

const drawFooter = (doc, academia, page, pages) => {
  const y = pageBottom(doc) - 14;
  const x = doc.page.margins.left;
  doc.moveTo(x, y - 7).lineTo(doc.page.width - doc.page.margins.right, y - 7).strokeColor(BORDER).lineWidth(0.5).stroke();
  doc.fillColor('#94A3B8').font('Helvetica').fontSize(6.8)
    .text(`${cleanText(academia.nombre, 'Academia Deportiva')} · Documento generado por Syncademia`, x, y, { width: contentWidth(doc) - 80, lineBreak: false });
  doc.text(`${page}/${pages}`, doc.page.width - doc.page.margins.right - 50, y, { width: 50, align: 'right', lineBreak: false });
};

const isInvalidEnrollmentTerms = (value) => {
  const text = optionalText(value);
  if (!text) return true;
  const normalized = text.toLowerCase();
  return /informe\s+t[eé]cnico|evaluaci[oó]n\s+formativa|observaciones\s+y\s+recomendaciones|\balumno\s*:|\bcategor[ií]a\s*:/.test(normalized)
    || /a[uú]n\s+no\s+se\s+han\s+(establecido|configurado)/.test(normalized);
};

const selectEnrollmentTerms = (academia = {}) => {
  const candidates = [academia.terminos_matricula, academia.contrato_matricula, academia.reglamento_interno, academia.terminos_condiciones];
  return candidates.find((value) => !isInvalidEnrollmentTerms(value)) || null;
};

const drawTerms = (doc, terms, theme) => {
  const x = doc.page.margins.left;
  const boxY = doc.y;
  const text = terms || 'La academia no mantiene términos adicionales de matrícula configurados en Syncademia. Cualquier reglamento o condición complementaria debe ser informado por los canales oficiales de la academia.';
  const fontSize = text.length > 2300 ? 7.2 : text.length > 1400 ? 7.8 : 8.6;
  doc.font('Helvetica').fontSize(fontSize);
  const measured = doc.heightOfString(text, { width: contentWidth(doc) - 28, lineGap: 2.5 });
  const boxHeight = Math.min(170, Math.max(78, measured + 30));
  doc.roundedRect(x, boxY, contentWidth(doc), boxHeight, 12).fill(LIGHT).strokeColor(BORDER).lineWidth(0.7).stroke();
  doc.fillColor(TEXT).font('Helvetica').fontSize(fontSize)
    .text(text, x + 14, boxY + 14, { width: contentWidth(doc) - 28, height: boxHeight - 28, lineGap: 2.5, ellipsis: measured > boxHeight - 28 });
  doc.y = boxY + boxHeight + 14;
};

const generateMatriculaPdf = async ({ academia, jugador, tutor, folio, consentimientos = [] }) => {
  const startedAt = Date.now();
  const theme = academyTheme(academia);
  const [logoBuffer, photoBuffer] = await Promise.all([
    loadImageBuffer(academia.logo || academia.logo_url, 'logo'),
    loadImageBuffer(jugador.foto_base64 || jugador.foto_url || jugador.avatar_url, 'photo'),
  ]);

  const doc = newDocument(`Matrícula ${folio}`);
  const bufferPromise = documentToBuffer(doc);
  const x = doc.page.margins.left;
  const w = contentWidth(doc);
  const studentDoc = jugador.rut || jugador.rut_pasaporte || jugador.rut_jugador || jugador.numero_documento;
  const tutorDoc = tutor.rut || tutor.rut_pasaporte || tutor.rut_tutor || tutor.dni;
  const matricula = Number(jugador.monto_matricula ?? jugador.valor_matricula) || 0;
  const abono = Number(jugador.abono_matricula ?? jugador.abono_inicial) || 0;
  const mensualidad = Number(jugador.monto_mensualidad ?? jugador.valor_mensualidad) || 0;
  const saldo = Math.max(0, matricula - abono);
  const terms = selectEnrollmentTerms(academia);

  drawBrandBar(doc, academia, 'Comprobante oficial de matrícula', `Folio ${folio} · ${shortDate(new Date())}`, logoBuffer, theme);

  const profileY = doc.y;
  drawPortrait(doc, photoBuffer, x, profileY, 92, 108, theme);
  doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(19)
    .text(cleanText(jugador.nombre).toUpperCase(), x + 112, profileY + 5, { width: w - 112, height: 48, ellipsis: true });
  doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(9.5)
    .text([jugador.posicion_cancha || jugador.posicion_principal, jugador.tipo_alumno].filter(Boolean).join(' · ') || 'Alumno', x + 112, profileY + 48, { width: w - 112 });
  doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
    .text(`Documento: ${cleanText(studentDoc, '-')}`, x + 112, profileY + 71, { width: 180 });
  doc.text(`Nacimiento: ${formatDate(jugador.fecha_nacimiento)}`, x + 292, profileY + 71, { width: w - 292 });
  doc.text(`Estado matrícula: ${cleanText(jugador.estado_matricula, 'Registrada')}`, x + 112, profileY + 91, { width: 180 });
  doc.text(`Academia: ${cleanText(academia.nombre)}`, x + 292, profileY + 91, { width: w - 292, ellipsis: true });
  doc.y = profileY + 125;

  drawSectionHeading(doc, 'Apoderado responsable', 'Datos de contacto asociados a esta inscripción', theme);
  drawDataRows(doc, [
    { label: 'Nombre', value: tutor.nombre_completo || tutor.nombre },
    { label: 'Documento', value: tutorDoc },
    { label: 'Teléfono', value: tutor.telefono },
    { label: 'Correo', value: tutor.email },
  ], theme, { columns: 2, rowHeight: 43 });

  drawSectionHeading(doc, 'Resumen financiero', 'Valores registrados en la matrícula', theme, doc.y + 2);
  drawKpiRow(doc, [
    { label: 'Matrícula', value: money(matricula) },
    { label: 'Abonado', value: money(abono), accent: true },
    { label: 'Saldo', value: money(saldo) },
    { label: 'Mensualidad', value: money(mensualidad) },
  ], theme);

  drawSectionHeading(doc, 'Entrenamiento y contacto', null, theme, doc.y - 2);
  drawDataRows(doc, [
    { label: 'Días', value: academia.dias_entrenamiento },
    { label: 'Horario', value: academia.horarios_entrenamiento },
    { label: 'Lugar', value: academia.ubicacion_entrenamiento || academia.direccion },
    { label: 'Contacto', value: academia.telefono || academia.director_email },
  ], theme, { columns: 2, rowHeight: 42 });
  drawFooter(doc, academia, 1, 2);

  doc.addPage();
  drawBrandBar(doc, academia, 'Condiciones y autorizaciones', `Matrícula ${folio}`, null, theme, { compact: true });
  drawSectionHeading(doc, 'Condiciones de matrícula', 'Texto configurado por la academia para esta inscripción', theme);
  drawTerms(doc, terms, theme);

  drawSectionHeading(doc, 'Privacidad y autorizaciones', 'Las autorizaciones de imagen son independientes de la matrícula', theme, doc.y - 2);
  drawConsentRows(doc, consentimientos, theme);

  const privacyY = doc.y + 2;
  doc.roundedRect(x, privacyY, w, 70, 12).fill('#F8FAFC').strokeColor(BORDER).lineWidth(0.6).stroke();
  doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(8.4).text('CONSTANCIA DE REGISTRO', x + 14, privacyY + 12);
  doc.fillColor(MUTED).font('Helvetica').fontSize(7.7)
    .text(`Apoderado: ${cleanText(tutor.nombre_completo || tutor.nombre)} · Documento: ${cleanText(tutorDoc, '-')}. Las decisiones anteriores fueron registradas durante el proceso de matrícula y pueden ser actualizadas o revocadas para usos futuros conforme a los canales definidos por la academia.`, x + 14, privacyY + 29, { width: w - 28, lineGap: 2 });
  doc.y = privacyY + 84;

  drawSectionHeading(doc, 'Responsable institucional', null, theme, doc.y);
  drawDataRows(doc, [
    { label: 'Director/a o responsable', value: academia.nombre_director || academia.director_nombre },
    { label: 'Correo', value: academia.director_email },
    { label: 'Teléfono', value: academia.telefono || academia.telefono_director },
    { label: 'Dirección', value: academia.direccion },
  ], theme, { columns: 2, rowHeight: 40 });

  const signY = Math.min(Math.max(doc.y + 12, 690), pageBottom(doc) - 72);
  doc.moveTo(x + 16, signY).lineTo(x + 210, signY).strokeColor(theme.primary).lineWidth(0.8).stroke();
  doc.moveTo(x + w - 210, signY).lineTo(x + w - 16, signY).strokeColor(theme.primary).lineWidth(0.8).stroke();
  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7).text('APODERADO / REPRESENTANTE', x + 16, signY + 7, { width: 194, align: 'center' });
  doc.text('ACADEMIA', x + w - 210, signY + 7, { width: 194, align: 'center' });
  drawFooter(doc, academia, 2, 2);

  doc.end();
  const buffer = await bufferPromise;
  buffer.generationMs = Date.now() - startedAt;
  return buffer;
};

const radarPoint = (cx, cy, radius, index, count, value = 100) => {
  const angle = -Math.PI / 2 + (Math.PI * 2 * index) / count;
  const r = radius * Math.max(0, Math.min(100, Number(value) || 0)) / 100;
  return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
};

const drawRadar = (doc, values, theme, x, y, width, height) => {
  const entries = Object.entries(values || {}).slice(0, 8);
  if (entries.length < 3) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(8).text('Aún no hay suficientes métricas para construir el perfil técnico.', x, y + height / 2 - 8, { width, align: 'center' });
    return;
  }
  const cx = x + width / 2;
  const cy = y + height / 2;
  const radius = Math.min(width, height) * 0.31;
  const count = entries.length;
  [25, 50, 75, 100].forEach((level) => {
    const points = entries.map((_, i) => radarPoint(cx, cy, radius, i, count, level));
    doc.moveTo(points[0].x, points[0].y);
    points.slice(1).forEach((p) => doc.lineTo(p.x, p.y));
    doc.closePath().strokeColor('#DDE5ED').lineWidth(0.45).stroke();
  });
  entries.forEach(([label], i) => {
    const end = radarPoint(cx, cy, radius, i, count, 100);
    const labelPt = radarPoint(cx, cy, radius + 22, i, count, 100);
    doc.moveTo(cx, cy).lineTo(end.x, end.y).strokeColor('#E5EAF0').lineWidth(0.4).stroke();
    doc.fillColor('#475569').font('Helvetica-Bold').fontSize(6.2).text(label, labelPt.x - 27, labelPt.y - 4, { width: 54, align: 'center' });
  });
  const scorePoints = entries.map(([, value], i) => radarPoint(cx, cy, radius, i, count, value));
  doc.moveTo(scorePoints[0].x, scorePoints[0].y);
  scorePoints.slice(1).forEach((p) => doc.lineTo(p.x, p.y));
  doc.closePath().fillOpacity(0.14).fillAndStroke(theme.accent, theme.accent).fillOpacity(1);
  scorePoints.forEach((p) => doc.circle(p.x, p.y, 2.1).fill(theme.primary));
};

const averageScore = (values = {}) => {
  const nums = Object.values(values).map(Number).filter(Number.isFinite);
  return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
};

const rankSkills = (values = {}) => Object.entries(values)
  .map(([name, score]) => ({ name, score: Number(score) || 0 }))
  .sort((a, b) => b.score - a.score);

const drawSkillBars = (doc, values, previous, theme, x, y, width) => {
  const entries = Object.entries(values || {}).slice(0, 7);
  let cy = y;
  entries.forEach(([skill, raw]) => {
    const score = Math.max(0, Math.min(100, Number(raw) || 0));
    const prev = Number(previous?.[skill]);
    const delta = Number.isFinite(prev) ? score - prev : null;
    doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(7.7).text(skill, x, cy, { width: width - 66, ellipsis: true, lineBreak: false });
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.3).text(`${score}/100`, x + width - 56, cy, { width: 56, align: 'right' });
    cy += 13;
    doc.roundedRect(x, cy, width, 6, 3).fill('#E9EEF4');
    doc.roundedRect(x, cy, width * score / 100, 6, 3).fill(theme.accent);
    if (delta !== null) {
      doc.fillColor(delta >= 0 ? SUCCESS : WARNING).font('Helvetica-Bold').fontSize(6.3)
        .text(`${delta >= 0 ? '+' : ''}${delta} vs. anterior`, x, cy + 9, { width });
      cy += 28;
    } else cy += 20;
  });
};

const generatePlayerReportPdf = async ({ academia, jugador, tutor, evaluaciones = [], stats = {}, comentarios = '' }) => {
  const startedAt = Date.now();
  const theme = academyTheme(academia);
  const [logoBuffer, photoBuffer] = await Promise.all([
    loadImageBuffer(academia.logo || academia.logo_url, 'logo'),
    loadImageBuffer(jugador.foto_base64 || jugador.foto_url || jugador.avatar_url, 'photo'),
  ]);
  const latestEvaluation = evaluaciones[0] || {};
  const previousEvaluation = evaluaciones[1] || {};
  const latest = latestEvaluation.datos_radar || {};
  const previous = previousEvaluation.datos_radar || {};
  const skills = rankSkills(latest);
  const strengths = skills.slice(0, 3);
  const focuses = [...skills].sort((a, b) => a.score - b.score).slice(0, 3);
  const attendanceTotal = (Number(stats.clases_presente) || 0) + (Number(stats.clases_ausente) || 0) + (Number(stats.clases_justificadas) || 0);
  const attendanceRate = attendanceTotal ? Math.round(((Number(stats.clases_presente) || 0) + (Number(stats.clases_justificadas) || 0)) * 100 / attendanceTotal) : null;
  const score = averageScore(latest);
  const doc = newDocument(`Informe de evolución - ${cleanText(jugador.nombre, 'Alumno')}`);
  const bufferPromise = documentToBuffer(doc);
  const x = doc.page.margins.left;
  const w = contentWidth(doc);
  const categories = (jugador.categorias || []).map((c) => c?.nombre).filter(Boolean).join(' · ');

  drawBrandBar(doc, academia, 'Informe de evolución deportiva', `Seguimiento privado · ${shortDate(new Date())}`, logoBuffer, theme);
  const profileY = doc.y;
  drawPortrait(doc, photoBuffer, x, profileY, 96, 112, theme);
  doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(20).text(cleanText(jugador.nombre).toUpperCase(), x + 116, profileY + 7, { width: w - 116, ellipsis: true });
  doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(9.5).text(cleanText(jugador.posicion_cancha || jugador.posicion_principal, 'Posición por definir'), x + 116, profileY + 40);
  doc.fillColor(MUTED).font('Helvetica').fontSize(8.4).text(`Categoría: ${cleanText(categories, 'Sin categoría')}`, x + 116, profileY + 62, { width: w - 116, ellipsis: true });
  doc.text(`Nacimiento: ${formatDate(jugador.fecha_nacimiento)} · Tipo: ${cleanText(jugador.tipo_alumno, 'Alumno')}`, x + 116, profileY + 81, { width: w - 116 });
  if (latestEvaluation.created_at) doc.text(`Última evaluación: ${shortDate(latestEvaluation.created_at)}`, x + 116, profileY + 99, { width: w - 116 });
  doc.y = profileY + 128;

  drawKpiRow(doc, [
    { label: 'Promedio técnico', value: score === null ? '-' : `${score}/100` },
    { label: 'Asistencia', value: attendanceRate === null ? '-' : `${attendanceRate}%`, accent: true },
    { label: 'Partidos', value: stats.partidos_jugados ?? 0 },
    { label: 'Goles + asist.', value: (Number(stats.goles) || 0) + (Number(stats.asistencias) || 0) },
  ], theme, doc.y);

  drawSectionHeading(doc, 'Perfil técnico actual', 'Comparación automática con la evaluación anterior cuando existe', theme, doc.y - 4);
  const panelY = doc.y;
  const leftW = 292;
  const gap = 16;
  const rightW = w - leftW - gap;
  doc.roundedRect(x, panelY, leftW, 238, 12).fill(WHITE).strokeColor(BORDER).lineWidth(0.7).stroke();
  drawRadar(doc, latest, theme, x + 8, panelY + 8, leftW - 16, 220);
  doc.roundedRect(x + leftW + gap, panelY, rightW, 238, 12).fill(LIGHT).strokeColor(BORDER).lineWidth(0.7).stroke();
  doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(9.5).text('EVOLUCIÓN POR HABILIDAD', x + leftW + gap + 14, panelY + 14, { width: rightW - 28 });
  drawSkillBars(doc, latest, previous, theme, x + leftW + gap + 14, panelY + 38, rightW - 28);
  doc.y = panelY + 250;
  drawFooter(doc, academia, 1, 2);

  doc.addPage();
  drawBrandBar(doc, academia, 'Lectura del período', 'Fortalezas, focos y acompañamiento familiar', null, theme, { compact: true });

  drawSectionHeading(doc, 'Fortalezas y focos de desarrollo', 'Lectura basada en la última evaluación registrada', theme);
  const colGap = 12;
  const colW = (w - colGap) / 2;
  const strengthY = doc.y;
  const drawRankCard = (bx, title, items, fill, color) => {
    doc.roundedRect(bx, strengthY, colW, 112, 12).fill(fill).strokeColor(BORDER).lineWidth(0.6).stroke();
    doc.fillColor(color).font('Helvetica-Bold').fontSize(9).text(title, bx + 13, strengthY + 13, { width: colW - 26 });
    if (!items.length) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(8).text('Aún no hay una evaluación registrada.', bx + 13, strengthY + 42, { width: colW - 26 });
      return;
    }
    items.forEach((item, idx) => {
      doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(8.2).text(`${idx + 1}. ${item.name}`, bx + 13, strengthY + 40 + idx * 21, { width: colW - 74, ellipsis: true, lineBreak: false });
      doc.fillColor(color).font('Helvetica-Bold').fontSize(8.2).text(`${item.score}/100`, bx + colW - 60, strengthY + 40 + idx * 21, { width: 46, align: 'right' });
    });
  };
  drawRankCard(x, 'FORTALEZAS', strengths, '#ECFDF5', SUCCESS);
  drawRankCard(x + colW + colGap, 'PRÓXIMOS FOCOS', focuses, '#FFF7ED', WARNING);
  doc.y = strengthY + 126;

  drawSectionHeading(doc, 'Actividad y constancia', null, theme, doc.y);
  drawDataRows(doc, [
    { label: 'Presente', value: stats.clases_presente ?? 0 },
    { label: 'Ausente', value: stats.clases_ausente ?? 0 },
    { label: 'Justificado', value: stats.clases_justificadas ?? 0 },
    { label: 'MVP', value: stats.mvp ?? 0 },
    { label: 'Goles', value: stats.goles ?? 0 },
    { label: 'Asistencias', value: stats.asistencias ?? 0 },
  ], theme, { columns: 3, rowHeight: 40 });

  drawSectionHeading(doc, 'Observación del cuerpo técnico', 'Mensaje preparado para la familia', theme, doc.y + 2);
  const commentsY = doc.y;
  doc.roundedRect(x, commentsY, w, 112, 12).fill(LIGHT).strokeColor(BORDER).lineWidth(0.7).stroke();
  doc.fillColor(TEXT).font('Helvetica').fontSize(9.2)
    .text(cleanText(comentarios || latestEvaluation.comentarios_profesor, 'Sin observaciones adicionales para este período.'), x + 15, commentsY + 15, { width: w - 30, height: 82, lineGap: 3, ellipsis: true });
  doc.y = commentsY + 126;

  const badges = Array.isArray(jugador.insignias) ? jugador.insignias.slice(0, 6) : [];
  if (badges.length) {
    drawSectionHeading(doc, 'Reconocimientos recientes', null, theme, doc.y - 2);
    const badgeText = badges.map((badge) => typeof badge === 'string' ? badge : badge?.nombre).filter(Boolean).join('   ·   ');
    doc.roundedRect(x, doc.y, w, 54, 10).fill('#FFFBEB').strokeColor('#FDE68A').stroke();
    doc.fillColor('#92400E').font('Helvetica-Bold').fontSize(8.3).text(badgeText, x + 14, doc.y + 14, { width: w - 28, height: 28, ellipsis: true, align: 'center' });
    doc.y += 68;
  }

  const closeY = Math.min(doc.y + 4, pageBottom(doc) - 86);
  doc.roundedRect(x, closeY, w, 60, 14).fill(theme.primary);
  doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(9.2).text('EL PROGRESO TAMBIÉN SE CONSTRUYE EN FAMILIA', x + 18, closeY + 13, { width: w - 36, align: 'center' });
  doc.fillColor('#CBD5E1').font('Helvetica').fontSize(7.8)
    .text(`Gracias por acompañar el proceso de ${cleanText(jugador.nombre, 'este alumno')}. ${cleanText(academia.nombre, 'La academia')} seguirá registrando avances para que cada evaluación muestre una historia de crecimiento, constancia y aprendizaje.`, x + 30, closeY + 30, { width: w - 60, align: 'center', lineGap: 1.5 });
  drawFooter(doc, academia, 2, 2);

  doc.end();
  const buffer = await bufferPromise;
  buffer.generationMs = Date.now() - startedAt;
  return buffer;
};

module.exports = {
  generateMatriculaPdf,
  generatePlayerReportPdf,
  loadImageBuffer,
  selectEnrollmentTerms,
};
