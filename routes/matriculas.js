const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const PDFDocument = require('pdfkit');

// Función auxiliar para generar el PDF en memoria (Buffer)
const generarPDFMatricula = (academia, jugador, tutor, folio) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    let buffers = [];

    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    // --- INICIO DEL DISEÑO DEL PDF ---
    
    // 1. Encabezado
    doc.fontSize(24).font('Helvetica-Bold').text(academia.nombre, { align: 'center' });
    doc.fontSize(10).font('Helvetica').text(academia.direccion || 'Sede Principal', { align: 'center' });
    doc.moveDown(2);

    // 2. Título y Folio
    doc.fontSize(16).font('Helvetica-Bold').text('CERTIFICADO DE MATRÍCULA', { align: 'center' });
    doc.fontSize(10).font('Helvetica').text(`Folio: ${folio}`, { align: 'center' });
    doc.text(`Fecha: ${new Date().toLocaleDateString('es-CL')}`, { align: 'center' });
    doc.moveDown(2);

    // 3. Datos del Jugador
    doc.fontSize(12).font('Helvetica-Bold').text('1. ANTECEDENTES DEL JUGADOR', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica');
    doc.text(`Nombre Completo: ${jugador.nombre_completo}`);
    doc.text(`RUT: ${jugador.rut}`);
    doc.text(`Posición / Categoría: ${jugador.posicion_cancha || 'Por definir'}`);
    doc.moveDown(1.5);

    // 4. Datos del Apoderado/Tutor
    doc.fontSize(12).font('Helvetica-Bold').text('2. ANTECEDENTES DEL APODERADO', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica');
    doc.text(`Nombre Completo: ${tutor.nombre_completo}`);
    doc.text(`RUT: ${tutor.rut}`);
    doc.text(`Teléfono: ${tutor.telefono}`);
    doc.text(`Correo Electrónico: ${tutor.email}`);
    doc.moveDown(2);

    // 5. Términos y Condiciones
    doc.fontSize(12).font('Helvetica-Bold').text('3. TÉRMINOS Y ACUERDOS DE LA ACADEMIA', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(9).font('Helvetica');
    
    // Usamos los términos personalizados del director, o un texto por defecto de seguridad
    const terminosTexto = academia.terminos_matricula || 'El apoderado y el jugador se comprometen a respetar el reglamento interno de la institución.';
    doc.text(terminosTexto, { align: 'justify', lineGap: 2 });
    doc.moveDown(4);

    // 6. Firmas
    doc.text('___________________________________', 50, doc.y);
    doc.text('___________________________________', 300, doc.y - 12);
    
    doc.moveDown(0.5);
    doc.text('Firma Apoderado', 90, doc.y);
    doc.text('Firma Director / Academia', 330, doc.y - 12);

    // --- FIN DEL DISEÑO ---
    doc.end();
  });
};

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
    const fileName = `${academia_id}/${folio}_${jugador.rut}.pdf`;
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
            <p>La matrícula de <strong>${jugador.nombre_completo}</strong> ha sido procesada exitosamente en <strong>${academia.nombre}</strong>.</p>
            <p>Adjunto a este correo encontrarás el comprobante oficial con el folio <strong>${folio}</strong> y los términos de la academia.</p>
            <br>
            <p>Atentamente,<br>El equipo de ${academia.nombre}</p>
          `,
          // 🔥 AQUÍ ADJUNTAMOS EL ARCHIVO PDF EN BASE64
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
