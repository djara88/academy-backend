const PDFDocument = require('pdfkit');
const { loadImageBuffer } = require('./premiumPdf');

const WHITE = '#FFFFFF';
const TEXT = '#0F172A';
const MUTED = '#64748B';
const BORDER = '#D8E0E8';
const LIGHT = '#F8FAFC';
const SUCCESS = '#15803D';
const WARNING = '#C2410C';

const clean = (value, fallback = '-') => String(value ?? '').trim() || fallback;
const money = (value) => `$${Math.round(Number(value) || 0).toLocaleString('es-CL')}`;
const dateTime = (value) => {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('es-CL');
};
const dateOnly = (value) => {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString('es-CL');
};
const contentWidth = (doc) => doc.page.width - doc.page.margins.left - doc.page.margins.right;
const pageBottom = (doc) => doc.page.height - doc.page.margins.bottom;
const themeFor = (academia = {}) => ({ primary: academia.color_primario || '#102A43', accent: academia.color_secundario || '#D4AF37' });
const toBuffer = (doc) => new Promise((resolve, reject) => {
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);
});

const brand = (doc, academia, title, subtitle, logo, theme) => {
  const x = doc.page.margins.left;
  const w = contentWidth(doc);
  doc.roundedRect(x, 42, w, 82, 14).fill(theme.primary);
  if (logo) {
    try { doc.image(logo, x + 14, 53, { fit: [58, 58], align: 'center', valign: 'center' }); } catch (_) {}
  }
  const tx = x + (logo ? 84 : 20);
  doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(17).text(title, tx, 58, { width: w - (tx - x) - 18 });
  doc.fillColor('#CBD5E1').font('Helvetica').fontSize(8).text(`${clean(academia.nombre, 'Academia Deportiva')} · ${subtitle}`, tx, 87, { width: w - (tx - x) - 18 });
  doc.y = 142;
};

const section = (doc, title, subtitle, theme, y = doc.y) => {
  const x = doc.page.margins.left;
  doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(9.5).text(title.toUpperCase(), x, y);
  if (subtitle) doc.fillColor(MUTED).font('Helvetica').fontSize(7.2).text(subtitle, x, y + 14);
  doc.y = y + (subtitle ? 32 : 22);
};

const grid = (doc, rows, theme, columns = 2, rowHeight = 44) => {
  const x = doc.page.margins.left;
  const gap = 9;
  const w = (contentWidth(doc) - gap * (columns - 1)) / columns;
  const startY = doc.y;
  rows.forEach((item, i) => {
    const row = Math.floor(i / columns);
    const col = i % columns;
    const bx = x + col * (w + gap);
    const by = startY + row * (rowHeight + gap);
    doc.roundedRect(bx, by, w, rowHeight, 9).fill(LIGHT).strokeColor(BORDER).lineWidth(0.6).stroke();
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(6.2).text(String(item.label).toUpperCase(), bx + 11, by + 9, { width: w - 22 });
    doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(8.4).text(clean(item.value), bx + 11, by + 23, { width: w - 22, height: rowHeight - 26, ellipsis: true });
  });
  doc.y = startY + Math.ceil(rows.length / columns) * (rowHeight + gap);
};

const footer = (doc, academia, page) => {
  const x = doc.page.margins.left;
  const y = pageBottom(doc) - 12;
  doc.moveTo(x, y - 7).lineTo(doc.page.width - doc.page.margins.right, y - 7).strokeColor(BORDER).lineWidth(0.5).stroke();
  doc.fillColor('#94A3B8').font('Helvetica').fontSize(6.4).text(`${clean(academia.nombre, 'Academia Deportiva')} · Matrícula digital generada por Syncademia`, x, y, { width: contentWidth(doc) - 50, lineBreak: false });
  doc.text(`${page}/2`, doc.page.width - doc.page.margins.right - 40, y, { width: 40, align: 'right', lineBreak: false });
};

const drawConsentRows = (doc, consentimientos) => {
  const labels = {
    aviso_privacidad: 'Aviso de privacidad y tratamiento operativo',
    datos_salud: 'Información mínima de emergencia',
    imagen_interna: 'Uso interno de fotografía',
    imagen_publica: 'Difusión pública de imagen',
  };
  const latest = {};
  (consentimientos || []).forEach((item) => { if (item?.tipo && !latest[item.tipo]) latest[item.tipo] = item; });
  const x = doc.page.margins.left;
  let y = doc.y;
  Object.entries(labels).forEach(([key, label]) => {
    const accepted = latest[key]?.estado === 'aceptado';
    doc.roundedRect(x, y, contentWidth(doc), 37, 8).fill(accepted ? '#ECFDF5' : '#FFF7ED');
    doc.circle(x + 18, y + 18.5, 7).fill(accepted ? SUCCESS : WARNING);
    doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(7).text(accepted ? '✓' : '–', x + 14, y + 14, { width: 8, align: 'center' });
    doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(8).text(label, x + 34, y + 10, { width: contentWidth(doc) - 150 });
    doc.fillColor(accepted ? SUCCESS : WARNING).font('Helvetica-Bold').fontSize(6.8).text(accepted ? 'AUTORIZADO' : 'NO AUTORIZADO', x + contentWidth(doc) - 110, y + 13, { width: 96, align: 'right' });
    y += 44;
  });
  doc.y = y + 2;
};

const signatureBuffer = async (dataUrl) => {
  if (!String(dataUrl || '').startsWith('data:image/')) return null;
  try { return await loadImageBuffer(dataUrl, 'signature'); } catch (_) { return null; }
};

const generateSignedEnrollmentPdf = async ({ academia, jugador, tutor, folio, terms, consentimientos = [], firma = {} }) => {
  const startedAt = Date.now();
  const theme = themeFor(academia);
  const [logo, photo, signature] = await Promise.all([
    loadImageBuffer(academia.logo || academia.logo_url, 'logo'),
    loadImageBuffer(jugador.foto_base64 || jugador.foto_url || jugador.avatar_url, 'photo'),
    signatureBuffer(firma.data_url),
  ]);
  const doc = new PDFDocument({ size: 'A4', margin: 42, info: { Title: `Matrícula firmada ${folio}` } });
  const bufferPromise = toBuffer(doc);
  const x = doc.page.margins.left;
  const w = contentWidth(doc);
  const studentDoc = jugador.rut || jugador.rut_pasaporte || jugador.numero_documento;
  const tutorDoc = tutor.rut || tutor.rut_pasaporte || tutor.rut_tutor || tutor.dni;
  const matricula = Number(jugador.monto_matricula ?? jugador.valor_matricula) || 0;
  const abono = Number(jugador.abono_matricula ?? jugador.abono_inicial) || 0;
  const mensualidad = Number(jugador.monto_mensualidad ?? jugador.valor_mensualidad) || 0;
  const saldo = Math.max(0, matricula - abono);

  brand(doc, academia, 'Matrícula oficial · firmada digitalmente', `Folio ${folio} · ${dateOnly(firma.fecha || new Date())}`, logo, theme);
  const py = doc.y;
  doc.roundedRect(x, py, 96, 110, 12).fill('#EEF2F7').strokeColor(BORDER).lineWidth(0.6).stroke();
  if (photo) { try { doc.save(); doc.roundedRect(x + 3, py + 3, 90, 104, 10).clip(); doc.image(photo, x + 3, py + 3, { fit: [90, 104], align: 'center', valign: 'center' }); doc.restore(); } catch (_) {} }
  doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(18).text(clean(jugador.nombre).toUpperCase(), x + 116, py + 6, { width: w - 116, height: 42, ellipsis: true });
  doc.fillColor(theme.accent).font('Helvetica-Bold').fontSize(9).text(clean(jugador.posicion_cancha, 'Alumno'), x + 116, py + 45);
  doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(`Documento: ${clean(studentDoc)}`, x + 116, py + 66);
  doc.text(`Nacimiento: ${dateOnly(jugador.fecha_nacimiento)}`, x + 116, py + 84);
  doc.text(`Estado: ${clean(jugador.estado_matricula, 'Activa')}`, x + 315, py + 84);
  doc.y = py + 125;

  section(doc, 'Apoderado responsable', 'Identidad y contacto asociados a la firma', theme);
  grid(doc, [
    { label: 'Nombre', value: tutor.nombre_completo || tutor.nombre },
    { label: 'Documento', value: tutorDoc },
    { label: 'Teléfono', value: tutor.telefono },
    { label: 'Correo', value: tutor.email },
  ], theme);

  section(doc, 'Resumen económico', 'Valores aceptados al formalizar la matrícula', theme, doc.y + 2);
  grid(doc, [
    { label: 'Matrícula', value: money(matricula) },
    { label: 'Abono inicial', value: money(abono) },
    { label: 'Saldo matrícula', value: money(saldo) },
    { label: 'Mensualidad', value: money(mensualidad) },
  ], theme);

  section(doc, 'Entrenamiento y contacto', null, theme, doc.y + 2);
  grid(doc, [
    { label: 'Días', value: academia.dias_entrenamiento },
    { label: 'Horario', value: academia.horarios_entrenamiento },
    { label: 'Lugar', value: academia.ubicacion_entrenamiento || academia.direccion },
    { label: 'Contacto academia', value: academia.telefono || academia.director_email },
  ], theme, 2, 42);
  footer(doc, academia, 1);

  doc.addPage();
  brand(doc, academia, 'Condiciones, autorizaciones y evidencia', `Matrícula ${folio}`, null, theme);
  section(doc, 'Condiciones aceptadas', 'Texto que el apoderado visualizó antes de firmar', theme);
  const termsText = clean(terms, 'Sin condiciones adicionales configuradas.');
  doc.font('Helvetica').fontSize(7.6);
  const measured = doc.heightOfString(termsText, { width: w - 28, lineGap: 2 });
  const termsHeight = Math.min(170, Math.max(70, measured + 28));
  doc.roundedRect(x, doc.y, w, termsHeight, 10).fill(LIGHT).strokeColor(BORDER).lineWidth(0.6).stroke();
  const termsY = doc.y;
  doc.fillColor(TEXT).font('Helvetica').fontSize(7.6).text(termsText, x + 14, termsY + 13, { width: w - 28, height: termsHeight - 25, lineGap: 2, ellipsis: measured > termsHeight - 25 });
  doc.y = termsY + termsHeight + 14;

  section(doc, 'Privacidad y autorizaciones', 'Cada decisión fue presentada y registrada por separado', theme);
  drawConsentRows(doc, consentimientos);

  section(doc, 'Evidencia de firma electrónica simple', 'Trazabilidad asociada al documento y a las decisiones anteriores', theme, doc.y + 2);
  const evidenceY = doc.y;
  doc.roundedRect(x, evidenceY, w, 132, 12).fill('#F8FAFC').strokeColor(BORDER).lineWidth(0.7).stroke();
  const sigX = x + 14;
  const sigY = evidenceY + 13;
  doc.roundedRect(sigX, sigY, 190, 78, 8).fill(WHITE).strokeColor('#CBD5E1').lineWidth(0.6).stroke();
  if (signature) {
    try { doc.image(signature, sigX + 8, sigY + 7, { fit: [174, 64], align: 'center', valign: 'center' }); } catch (_) {}
  } else doc.fillColor(MUTED).font('Helvetica').fontSize(7).text('Firma registrada digitalmente', sigX + 10, sigY + 34, { width: 170, align: 'center' });
  doc.fillColor(theme.primary).font('Helvetica-Bold').fontSize(7.6).text(clean(firma.nombre || tutor.nombre_completo || tutor.nombre), x + 222, evidenceY + 16, { width: w - 236 });
  doc.fillColor(MUTED).font('Helvetica').fontSize(6.8)
    .text(`Documento: ${clean(firma.documento || tutorDoc)}`, x + 222, evidenceY + 35, { width: w - 236 })
    .text(`Fecha y hora: ${dateTime(firma.fecha)}`, x + 222, evidenceY + 51, { width: w - 236 })
    .text(`IP registrada: ${clean(firma.ip, 'No disponible')}`, x + 222, evidenceY + 67, { width: w - 236 });
  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(6.2).text('HUELLA DE EVIDENCIA SHA-256', x + 222, evidenceY + 87, { width: w - 236 });
  doc.fillColor('#334155').font('Courier').fontSize(5.5).text(clean(firma.evidence_sha256), x + 222, evidenceY + 101, { width: w - 236, lineBreak: true });
  doc.y = evidenceY + 146;

  const institutionalY = Math.min(doc.y, 700);
  doc.roundedRect(x, institutionalY, w, 54, 10).fill(theme.primary);
  doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(8).text('RESPONSABLE INSTITUCIONAL', x + 14, institutionalY + 11);
  doc.fillColor('#CBD5E1').font('Helvetica').fontSize(7).text(`${clean(academia.nombre_director || academia.director_nombre, academia.nombre)} · ${clean(academia.director_email || academia.telefono, '')}`, x + 14, institutionalY + 28, { width: w - 28 });
  footer(doc, academia, 2);

  doc.end();
  const buffer = await bufferPromise;
  buffer.generationMs = Date.now() - startedAt;
  return buffer;
};

module.exports = { generateSignedEnrollmentPdf };
