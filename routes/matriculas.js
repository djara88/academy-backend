const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const PDFDocument = require('pdfkit');

// ============================================================================
// Función auxiliar para generar el PDF en memoria (Diseño Premium SaaS)
// ============================================================================
const generarPDFMatricula = (academia, jugador, tutor, folio) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 0, size: 'A4' });
    let buffers = [];

    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    // ==========================================
    // 🎨 PALETA DE COLORES Y ESTILOS
    // ==========================================
    const colorPrincipal = '#1a2b3c';
    const colorAcento = '#289E9D';
    const colorGris = '#f4f4f4';
    const colorTexto = '#333333';
    
    const margenIzquierdo = 50;
    const anchoContenido = doc.page.width - 100;

    // ==========================================
    // 1. ENCABEZADO (HEADER) MODERNO
    // ==========================================
    doc.rect(0, 0, doc.page.width, 120).fill(colorPrincipal);
    
    doc.fillColor('#ffffff')
       .fontSize(28)
       .font('Helvetica-Bold')
       .text(academia.nombre.toUpperCase(), 0, 40, { align: 'center' });
       
    doc.fontSize(10)
       .font('Helvetica')
       .text(academia.direccion || 'Sede Principal', { align: 'center' });

    // ==========================================
    // 2. TÍTULO Y DATOS DEL FOLIO
    // ==========================================
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

    doc.moveTo(margenIzquierdo, 215).lineTo(doc.page.width - 50, 215).lineWidth(1).strokeColor(colorAcento).stroke();

    // ==========================================
    // 3. CAJA DE DATOS DEL JUGADOR
    // ==========================================
    let yPos = 230;
    
    doc.rect(margenIzquierdo, yPos, anchoContenido, 25).fill(colorGris);
    doc.fillColor(colorPrincipal).fontSize(12).font('Helvetica-Bold').text('1. ANTECEDENTES DEL JUGADOR', margenIzquierdo + 10, yPos + 7);
    
    yPos += 35;
    doc.fillColor(colorTexto).fontSize(10).font('Helvetica');
    
    doc.text(`Nombre:`, margenIzquierdo, yPos).font('Helvetica-Bold').text(jugador.nombre || 'No registrado', margenIzquierdo + 120, yPos);
    
    yPos += 18;
    doc.font('Helvetica').text(`RUT Alumno:`, margenIzquierdo, yPos).font('Helvetica-Bold').text(jugador.rut || 'No registrado', margenIzquierdo + 120, yPos);
    
    yPos += 18;
    doc.font('Helvetica').text(`Fecha Nacimiento:`, margenIzquierdo, yPos).font('Helvetica-Bold').text(jugador.fecha_nacimiento || 'No registrada', margenIzquierdo + 120, yPos);
    
    yPos += 18;
    doc.font('Helvetica').text(`Posición / Cat:`, margenIzquierdo, yPos).font('Helvetica-Bold').text(jugador.posicion_cancha || 'Por definir', margenIzquierdo + 120, yPos);

    yPos += 18;
    doc.font('Helvetica').text(`Tipo de Alumno:`, margenIzquierdo, yPos)
       .font('Helvetica-Bold').fillColor(jugador.tipo_alumno === 'Antiguo' ? colorAcento : colorPrincipal)
       .text(jugador.tipo_alumno || 'Nuevo', margenIzquierdo + 120, yPos);
       
    yPos += 18;
    doc.fillColor(colorTexto).font('Helvetica').text(`Certificado Médico:`, margenIzquierdo, yPos)
       .font('Helvetica-Bold').fillColor(jugador.certificado_medico === 'Entregado' ? '#27ae60' : '#e74c3c')
       .text((jugador.certificado_medico || 'Pendiente').toUpperCase(), margenIzquierdo + 120, yPos);

    // ==========================================
    // 4. CAJA DE DATOS DEL APODERADO
    // ==========================================
    yPos += 35;
    doc.rect(margenIzquierdo, yPos, anchoContenido, 25).fill(colorGris);
    doc.fillColor(colorPrincipal).fontSize(12).font('Helvetica-Bold').text('2. ANTECEDENTES DEL APODERADO', margenIzquierdo + 10, yPos + 7);
    
    yPos += 35;
    doc.fillColor(colorTexto).fontSize(10).font('Helvetica');
    
    doc.text(`Nombre Completo:`, margenIzquierdo, yPos).font('Helvetica-Bold').text(tutor.nombre_completo || 'No registrado', margenIzquierdo + 120, yPos);
    
    yPos += 18;
    doc.font('Helvetica').text(`RUT Apoderado:`, margenIzquierdo, yPos).font('Helvetica-Bold').text(tutor.rut || 'No registrado', margenIzquierdo + 120, yPos);
    
    yPos += 18;
    doc.font('Helvetica').text(`Teléfono:`, margenIzquierdo, yPos).font('Helvetica-Bold').text(tutor.telefono || 'No registrado', margenIzquierdo + 120, yPos);
    
    yPos += 18;
    doc.font('Helvetica').text(`Correo:`, margenIzquierdo, yPos).font('Helvetica-Bold').text(tutor.email || 'No registrado', margenIzquierdo + 120, yPos);

    // ==========================================
    // 5. TÉRMINOS Y CONDICIONES (NUMERACIÓN CLÁSICA)
    // ==========================================
    yPos += 35;
    doc.rect(margenIzquierdo, yPos, anchoContenido, 25).fill(colorGris);
    doc.fillColor(colorPrincipal).fontSize(12).font('Helvetica-Bold').text('3. ACUERDOS Y TÉRMINOS DE LA ACADEMIA', margenIzquierdo + 10, yPos + 7);
    
    yPos += 35;
    
    const terminosTexto = academia.terminos_matricula || 'El apoderado se compromete a respetar el reglamento interno de la institución.';
    const listaTerminos = terminosTexto.split('\n').filter(t => t.trim() !== '');
    
    listaTerminos.forEach((termino, index) => {
      let textoLimpio = termino.trim().replace(/[A-ZĐ]$/g, '').trim(); 
      
      doc.fillColor(colorPrincipal).font('Helvetica-Bold').fontSize(10).text(`${index + 1}.`, margenIzquierdo, yPos);
      doc.fillColor(colorTexto).font('Helvetica').text(textoLimpio, margenIzquierdo + 20, yPos, { width: anchoContenido - 20, align: 'justify' });
      
      yPos += doc.heightOfString(textoLimpio, { width: anchoContenido - 20 }) + 10;
    });

    // ==========================================
    // 6. ZONA DE FIRMAS
    // ==========================================
    yPos = 720; 
    doc.moveTo(margenIzquierdo + 20, yPos).lineTo(margenIzquierdo + 200, yPos).lineWidth(1).strokeColor(colorPrincipal).stroke();
    doc.moveTo(doc.page.width - 220, yPos).lineTo(doc.page.width - 40, yPos).lineWidth(1).strokeColor(colorPrincipal).stroke();
    
    doc.fillColor(colorTexto).fontSize(10).font('Helvetica-Bold');
    doc.text('Firma Apoderado / Tutor', margenIzquierdo + 20, yPos + 10, { width: 180, align: 'center' });
    doc.text('Firma Director / Academia', doc.page.width - 220, yPos + 10, { width: 180, align: 'center' });

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

    // 1. Obtener datos completos de la Base de Datos
    const { data: academia } = await supabase.from('academias').select('*').eq('id', academia_id).single();
    const { data: jugador } = await supabase.from('jugadores').select('*').eq('id', jugador_id).single();
    const { data: tutor } = await supabase.from('tutores').select('*').eq('id', tutor_id).single();

    if (!academia || !jugador || !tutor) {
      return res.status(404).json({ error: 'Faltan datos para generar la matrícula' });
    }

    // 2. Generar Folio y Crear el PDF en memoria
    const folio = `MAT-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const pdfBuffer = await generarPDFMatricula(academia, jugador, tutor, folio);

    // 3. Subir el PDF al bucket de Supabase
    const identificador = tutor.rut || folio;
    const fileName = `${academia_id}/${folio}_${identificador}.pdf`;
    
    const { error: uploadError } = await supabase.storage
      .from('matriculas-pdf')
      .upload(fileName, pdfBuffer, { contentType: 'application/pdf' });

    if (uploadError) throw new Error('Error al guardar el PDF en Storage');

    const { data: publicUrlData } = supabase.storage.from('matriculas-pdf').getPublicUrl(fileName);
    const pdfUrl = publicUrlData.publicUrl;

    // 4. Enviar correo al Apoderado usando Brevo con el PDF ADJUNTO
    const brevoApiKey = process.env.BREVO_API_KEY;
    const brevoSender = process.env.BREVO_SENDER_EMAIL;

    if (brevoApiKey && brevoSender && tutor.email) {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'api-key': brevoApiKey,
          'content-type': 'application/json'
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
          attachment: [
            {
              content: pdfBuffer.toString('base64'),
              name: `Matricula_${folio}.pdf`
            }
          ]
        })
      });
      console.log(`✅ Correo de matrícula enviado con éxito a ${tutor.email}`);
    }

    // Retornamos la URL para que el Director lo pueda descargar en su PC
    res.status(201).json({ success: true, url: pdfUrl, folio });

  } catch (error) {
    console.error('❌ Error generando matrícula:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
