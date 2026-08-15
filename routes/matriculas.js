const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const PDFDocument = require('pdfkit');
const { fetchWithTimeout } = require('../services/httpClient');

// ============================================================================
// Función auxiliar para generar el PDF en memoria (Diseño Premium SaaS)
// ============================================================================
const generarPDFMatricula = (academia, jugador, tutor, folio) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 0, size: 'A4' });
    const buffers = [];

    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const colorPrincipal = '#1a2b3c';
    const colorAcento = '#289E9D';
    const colorGris = '#f4f4f4';
    const colorTexto = '#333333';
    const margenIzquierdo = 50;
    const anchoContenido = doc.page.width - 100;

    doc.rect(0, 0, doc.page.width, 120).fill(colorPrincipal);
    doc.fillColor('#ffffff')
      .fontSize(28)
      .font('Helvetica-Bold')
      .text(academia.nombre.toUpperCase(), 0, 40, { align: 'center' });
    doc.fontSize(10)
      .font('Helvetica')
      .text(academia.direccion || 'Sede Principal', { align: 'center' });

    doc.moveDown(3);
    doc.fillColor(colorAcento)
      .fontSize(18)
      .font('Helvetica-Bold')
      .text('CERTIFICADO OFICIAL DE MATRÍCULA', margenIzquierdo, 150);
    doc.fillColor(colorTexto)
      .fontSize(10)
      .font('Helvetica-Bold')
      .text(`Folio: ${folio}`, margenIzquierdo, 175)
      .font('Helvetica')
      .text(`Fecha de emisión: ${new Date().toLocaleDateString('es-CL')}`, margenIzquierdo, 190);
    doc.moveTo(margenIzquierdo, 215)
      .lineTo(doc.page.width - 50, 215)
      .lineWidth(1)
      .strokeColor(colorAcento)
      .stroke();

    let yPos = 230;
    doc.rect(margenIzquierdo, yPos, anchoContenido, 25).fill(colorGris);
    doc.fillColor(colorPrincipal)
      .fontSize(12)
      .font('Helvetica-Bold')
      .text('1. ANTECEDENTES DEL JUGADOR', margenIzquierdo + 10, yPos + 7);

    yPos += 35;
    doc.fillColor(colorTexto).fontSize(10).font('Helvetica');
    doc.text('Nombre:', margenIzquierdo, yPos)
      .font('Helvetica-Bold')
      .text(jugador.nombre || 'No registrado', margenIzquierdo + 120, yPos);
    yPos += 18;
    doc.font('Helvetica').text('RUT Alumno:', margenIzquierdo, yPos)
      .font('Helvetica-Bold')
      .text(jugador.rut || 'No registrado', margenIzquierdo + 120, yPos);
    yPos += 18;
    doc.font('Helvetica').text('Fecha Nacimiento:', margenIzquierdo, yPos)
      .font('Helvetica-Bold')
      .text(jugador.fecha_nacimiento || 'No registrada', margenIzquierdo + 120, yPos);
    yPos += 18;
    doc.font('Helvetica').text('Posición / Cat:', margenIzquierdo, yPos)
      .font('Helvetica-Bold')
      .text(jugador.posicion_cancha || 'Por definir', margenIzquierdo + 120, yPos);
    yPos += 18;
    doc.font('Helvetica').text('Tipo de Alumno:', margenIzquierdo, yPos)
      .font('Helvetica-Bold')
      .fillColor(jugador.tipo_alumno === 'Antiguo' ? colorAcento : colorPrincipal)
      .text(jugador.tipo_alumno || 'Nuevo', margenIzquierdo + 120, yPos);
    yPos += 18;
    doc.fillColor(colorTexto).font('Helvetica').text('Certificado Médico:', margenIzquierdo, yPos)
      .font('Helvetica-Bold')
      .fillColor(jugador.certificado_medico === 'Entregado' ? '#27ae60' : '#e74c3c')
      .text((jugador.certificado_medico || 'Pendiente').toUpperCase(), margenIzquierdo + 120, yPos);

    yPos += 35;
    doc.rect(margenIzquierdo, yPos, anchoContenido, 25).fill(colorGris);
    doc.fillColor(colorPrincipal)
      .fontSize(12)
      .font('Helvetica-Bold')
      .text('2. ANTECEDENTES DEL APODERADO', margenIzquierdo + 10, yPos + 7);
    yPos += 35;
    doc.fillColor(colorTexto).fontSize(10).font('Helvetica');
    doc.text('Nombre Completo:', margenIzquierdo, yPos)
      .font('Helvetica-Bold')
      .text(tutor.nombre_completo || 'No registrado', margenIzquierdo + 120, yPos);
    yPos += 18;
    doc.font('Helvetica').text('RUT Apoderado:', margenIzquierdo, yPos)
      .font('Helvetica-Bold')
      .text(tutor.rut || 'No registrado', margenIzquierdo + 120, yPos);
    yPos += 18;
    doc.font('Helvetica').text('Teléfono:', margenIzquierdo, yPos)
      .font('Helvetica-Bold')
      .text(tutor.telefono || 'No registrado', margenIzquierdo + 120, yPos);
    yPos += 18;
    doc.font('Helvetica').text('Correo:', margenIzquierdo, yPos)
      .font('Helvetica-Bold')
      .text(tutor.email || 'No registrado', margenIzquierdo + 120, yPos);

    yPos += 35;
    doc.rect(margenIzquierdo, yPos, anchoContenido, 25).fill(colorGris);
    doc.fillColor(colorPrincipal)
      .fontSize(12)
      .font('Helvetica-Bold')
      .text('3. ACUERDOS Y TÉRMINOS DE LA ACADEMIA', margenIzquierdo + 10, yPos + 7);
    yPos += 35;

    const terminosTexto = academia.terminos_matricula || 'El apoderado se compromete a respetar el reglamento interno de la institución.';
    const listaTerminos = terminosTexto.split('\n').filter((t) => t.trim() !== '');
    listaTerminos.forEach((termino, index) => {
      const textoLimpio = termino.trim().replace(/[A-ZĐ]$/g, '').trim();
      doc.fillColor(colorPrincipal)
        .font('Helvetica-Bold')
        .fontSize(10)
        .text(`${index + 1}.`, margenIzquierdo, yPos);
      doc.fillColor(colorTexto)
        .font('Helvetica')
        .text(textoLimpio, margenIzquierdo + 20, yPos, {
          width: anchoContenido - 20,
          align: 'justify',
        });
      yPos += doc.heightOfString(textoLimpio, { width: anchoContenido - 20 }) + 10;
    });

    yPos = 720;
    doc.moveTo(margenIzquierdo + 20, yPos)
      .lineTo(margenIzquierdo + 200, yPos)
      .lineWidth(1)
      .strokeColor(colorPrincipal)
      .stroke();
    doc.moveTo(doc.page.width - 220, yPos)
      .lineTo(doc.page.width - 40, yPos)
      .lineWidth(1)
      .strokeColor(colorPrincipal)
      .stroke();
    doc.fillColor(colorTexto).fontSize(10).font('Helvetica-Bold');
    doc.text('Firma Apoderado / Tutor', margenIzquierdo + 20, yPos + 10, {
      width: 180,
      align: 'center',
    });
    doc.text('Firma Director / Academia', doc.page.width - 220, yPos + 10, {
      width: 180,
      align: 'center',
    });

    doc.end();
  });
};

// ============================================================================
// RUTA PRINCIPAL: POST /api/matriculas/generar-documento
// ============================================================================
router.post('/generar-documento', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { jugador_id, tutor_id } = req.body;

    if (!academia_id || !jugador_id || !tutor_id) {
      return res.status(400).json({ error: 'Faltan datos para generar la matrícula' });
    }

    // Cada entidad se valida dentro de la academia autenticada. No se confía
    // en IDs enviados por el cliente para definir la pertenencia multi-tenant.
    const [academiaResult, jugadorResult, tutorResult] = await Promise.all([
      supabase.from('academias').select('*').eq('id', academia_id).maybeSingle(),
      supabase.from('jugadores').select('*').eq('id', jugador_id).eq('academia_id', academia_id).maybeSingle(),
      supabase.from('tutores').select('*').eq('id', tutor_id).eq('academia_id', academia_id).maybeSingle(),
    ]);

    if (academiaResult.error || jugadorResult.error || tutorResult.error) {
      throw new Error('No fue posible validar los datos de la matrícula');
    }

    const academia = academiaResult.data;
    const jugador = jugadorResult.data;
    const tutor = tutorResult.data;

    if (!academia || !jugador || !tutor) {
      return res.status(404).json({ error: 'Jugador o tutor no pertenece a la academia autenticada' });
    }

    const folio = `MAT-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const pdfBuffer = await generarPDFMatricula(academia, jugador, tutor, folio);

    // El bucket es privado. El nombre del objeto no contiene RUT, email ni
    // ningún otro dato personal.
    const fileName = `${academia_id}/${folio}.pdf`;
    const { error: uploadError } = await supabase.storage
      .from('matriculas-pdf')
      .upload(fileName, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: false,
      });

    if (uploadError) throw new Error('Error al guardar el PDF en Storage');

    // URL temporal de 15 minutos: suficiente para la descarga inmediata y sin
    // convertir documentos con datos personales en recursos públicos permanentes.
    const { data: signedData, error: signedError } = await supabase.storage
      .from('matriculas-pdf')
      .createSignedUrl(fileName, 15 * 60);

    if (signedError || !signedData?.signedUrl) {
      throw new Error('No fue posible generar el enlace seguro del PDF');
    }

    const brevoApiKey = process.env.BREVO_API_KEY;
    const brevoSender = process.env.BREVO_SENDER_EMAIL;

    if (brevoApiKey && brevoSender && tutor.email) {
      const emailResponse = await fetchWithTimeout('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'api-key': brevoApiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sender: { name: academia.nombre, email: brevoSender },
          to: [{ email: tutor.email, name: tutor.nombre_completo }],
          subject: `Comprobante de Matrícula - ${academia.nombre}`,
          htmlContent: `
            <h2>¡Hola ${tutor.nombre_completo}!</h2>
            <p>La matrícula de <strong>${jugador.nombre || 'el alumno'}</strong> ha sido procesada exitosamente en <strong>${academia.nombre}</strong>.</p>
            <p>Adjunto a este correo encontrarás el comprobante oficial con el folio <strong>${folio}</strong> y los términos de la academia.</p>
            <br>
            <p>Atentamente,<br>El equipo de ${academia.nombre}</p>
          `,
          attachment: [{
            content: pdfBuffer.toString('base64'),
            name: `Matricula_${folio}.pdf`,
          }],
        }),
      }, 10000);

      if (!emailResponse.ok) {
        console.warn(`⚠️ Brevo rechazó correo de matrícula (HTTP ${emailResponse.status}).`);
      } else {
        console.log('✅ Correo de matrícula enviado correctamente.');
      }
    }

    res.status(201).json({
      success: true,
      url: signedData.signedUrl,
      folio,
      url_expires_in_seconds: 15 * 60,
    });
  } catch (error) {
    console.error('❌ Error generando matrícula:', error?.message || 'error interno');
    res.status(500).json({ success: false, error: 'No fue posible generar la matrícula' });
  }
});

module.exports = router;
