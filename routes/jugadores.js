const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const PDFDocument = require('pdfkit');

// --- FUNCIÓN AUXILIAR: Generar Contrato en PDF ---
function generarContratoPDF(datos, academiaInfo) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50 });
      let buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        resolve(Buffer.concat(buffers).toString('base64'));
      });

      const nombreAcademia = academiaInfo.nombre ? academiaInfo.nombre.toUpperCase() : 'NUESTRA ACADEMIA';

      // Diseño del PDF 100% dinámico
      doc.fontSize(22).fillColor('#2E466A').text(nombreAcademia, { align: 'center' });
      doc.fontSize(14).fillColor('#7F8C8D').text('CONTRATO OFICIAL DE MATRÍCULA', { align: 'center' });
      doc.moveDown();
      
      doc.fontSize(12).fillColor('#333333').text(`Folio de Registro: ${datos.folio}`, { align: 'right' });
      doc.text(`Fecha: ${new Date().toLocaleDateString('es-CL')}`, { align: 'right' });
      doc.moveDown(2);

      doc.fontSize(14).fillColor('#289E9D').text('1. DATOS DEL APODERADO', { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(12).fillColor('#333333');
      doc.text(`Nombre Completo: ${datos.tutor.nombre_completo}`);
      doc.text(`RUT: ${datos.tutor.rut}`);
      doc.text(`Teléfono: ${datos.tutor.telefono}`);
      doc.text(`Email: ${datos.tutor.email}`);
      doc.moveDown();

      doc.fontSize(14).fillColor('#289E9D').text('2. DATOS DEL ALUMNO', { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(12).fillColor('#333333');
      doc.text(`Nombre Completo: ${datos.nombre}`);
      doc.text(`Categoría Asignada: ${datos.categoria}`);
      doc.text(`Posición en Cancha: ${datos.posicion_cancha}`);
      doc.text(`Número de Camiseta: #${datos.numero_camiseta}`);
      doc.moveDown();

      doc.fontSize(14).fillColor('#289E9D').text('3. DETALLE FINANCIERO', { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(12).fillColor('#333333');
      doc.text(`Valor Matrícula Anual: $${datos.monto_matricula}`);
      doc.text(`Abono Inicial Registrado: $${datos.abono_matricula}`);
      doc.text(`Mensualidad Pactada: $${datos.monto_mensualidad}`);
      doc.moveDown(3);

      doc.fontSize(10).fillColor('#7F8C8D').text(`Este documento certifica la inscripción formal del alumno en ${nombreAcademia} y el compromiso de participación activa en nuestras actividades formativas y deportivas.`, { align: 'center' });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

// --- FUNCIÓN AUXILIAR: Enviar Correo Transaccional vía Brevo API REST ---
async function enviarCorreoBrevo(emailDestino, nombreDestino, base64Pdf, folio, nombreAlumno, academiaInfo) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL || academiaInfo.director_correo || 'contacto@academia.com';
  const nombreAcademia = academiaInfo.nombre || 'Nuestra Academia';

  if (!apiKey) {
    console.warn('⚠️ No se configuró BREVO_API_KEY en las variables de entorno. Se omite el envío de correo.');
    return;
  }

  const body = {
    sender: { name: nombreAcademia, email: senderEmail },
    to: [{ email: emailDestino, name: nombreDestino }],
    subject: `Confirmación de Matrícula - Folio ${folio}`,
    htmlContent: `
      <div style="font-family: Arial, sans-serif; color: #333;">
        <h2 style="color: #2E466A;">¡Hola ${nombreDestino}!</h2>
        <p>Es un placer informarte que el alumno <b>${nombreAlumno}</b> ha sido matriculado exitosamente en <b>${nombreAcademia}</b>.</p>
        <p>Adjunto a este correo encontrarás el <b>Contrato de Matrícula (Folio: ${folio})</b> en formato PDF con todos los detalles financieros y de registro.</p>
        <p>Cualquier duda, estamos a tu entera disposición.</p>
        <br>
        <p><b>¡Bienvenidos al equipo! ⚽💚</b></p>
        <p>Administración ${nombreAcademia}</p>
      </div>
    `,
    attachment: [{
      content: base64Pdf,
      name: `Contrato_Matricula_${folio}.pdf`
    }]
  };

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': apiKey,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const err = await response.json();
      console.error('❌ Error desde la API de Brevo:', err);
    } else {
      console.log(`✅ Correo de matrícula enviado a ${emailDestino} exitosamente vía Brevo.`);
    }
  } catch (error) {
    console.error('❌ Error al intentar conectar con la API de Brevo:', error);
  }
}

// GET: Listar jugadores
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { data, error } = await supabase
      .from('jugadores')
      .select(`*, tutor:tutores(nombre_completo, telefono, email), ficha_medica(*)`)
      .eq('academia_id', academia_id);
    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST: Crear un nuevo jugador (MATRÍCULA)
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const {
      tutor: tutorData, nombre, sexo, fecha_nacimiento, posicion_cancha,
      talla_uniforme, talla_apoderado, numero_camiseta, nombre_camiseta,
      foto_base64, evaluacion, ficha_medica,
      monto_matricula, abono_matricula, monto_mensualidad
    } = req.body;

    // A. OBTENER INFO DE LA ACADEMIA (Para el folio y PDF dinámicos)
    const { data: academiaInfo, error: academiaError } = await supabase
      .from('academias')
      .select('nombre, abreviacion, director_correo')
      .eq('id', academia_id)
      .single();
    
    if (academiaError) throw academiaError;

    // Generar prefijo del folio
    let prefijoFolio = 'ACA';
    if (academiaInfo && academiaInfo.abreviacion) {
      prefijoFolio = academiaInfo.abreviacion.toUpperCase();
    } else if (academiaInfo && academiaInfo.nombre) {
      prefijoFolio = academiaInfo.nombre.substring(0, 3).toUpperCase();
    }
    const folio = `${prefijoFolio}-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;

    // B. CREAR O ACTUALIZAR TUTOR
    let tutor;
    const { data: existingTutor, error: findError } = await supabase
      .from('tutores').select('*').eq('rut', tutorData.rut).eq('academia_id', academia_id).maybeSingle();
    
    if (findError) throw findError;

    if (existingTutor) {
      const { data: updatedTutor, error: updateError } = await supabase
        .from('tutores')
        .update({ nombre_completo: tutorData.nombre_completo, telefono: tutorData.telefono, email: tutorData.email })
        .eq('id', existingTutor.id).select().single();
      if (updateError) throw updateError;
      tutor = updatedTutor;
    } else {
      const { data: newTutor, error: insertError } = await supabase
        .from('tutores')
        .insert([{ academia_id, nombre_completo: tutorData.nombre_completo, rut: tutorData.rut, telefono: tutorData.telefono, email: tutorData.email }])
        .select().single();
      if (insertError) throw insertError;
      tutor = newTutor;
    }

    // C. SUBIR FOTO A STORAGE
    let foto_url = null;
    if (foto_base64) {
      const base64Data = foto_base64.split(';base64,').pop();
      const fileName = `alumno_${academia_id}_${Date.now()}.jpg`;
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('fotos_alumnos')
        .upload(fileName, Buffer.from(base64Data, 'base64'), { contentType: 'image/jpeg' });
      if (uploadError) throw uploadError;
      const { data: publicUrl } = supabase.storage.from('fotos_alumnos').getPublicUrl(fileName);
      foto_url = publicUrl.publicUrl;
    }

    // D. CALCULAR CATEGORÍA
    const edad = new Date().getFullYear() - new Date(fecha_nacimiento).getFullYear();
    const { data: categorias, error: catError } = await supabase
      .from('config_categorias').select('nombre, edad_maxima').eq('academia_id', academia_id).order('edad_maxima', { ascending: true });
    if (catError) throw catError;

    let categoria = 'Sin Categoría';
    for (const cat of categorias) {
      if (edad <= cat.edad_maxima) { categoria = cat.nombre; break; }
    }
    if (categoria === 'Sin Categoría' && categorias.length > 0) categoria = categorias[categorias.length - 1].nombre;

    // E. INSERTAR JUGADOR Y ANEXOS
    const estado_matricula = (abono_matricula >= monto_matricula) ? 'Pagada' : 'Pendiente';
    const { data: jugador, error: jugError } = await supabase
      .from('jugadores')
      .insert([{
        academia_id, tutor_id: tutor.id, nombre, sexo, fecha_nacimiento, posicion_cancha, talla_uniforme, talla_apoderado, numero_camiseta, nombre_camiseta: nombre_camiseta?.toUpperCase() || '', foto_ruta: foto_url, estado_matricula, monto_matricula, monto_pagado_matricula: abono_matricula, monto_mensualidad, tipo_alumno: 'Nuevo', estado_uniforme: 'Pendiente', estado_uniforme_apoderado: (talla_apoderado && talla_apoderado !== 'No desea') ? 'Pendiente' : 'No Aplica', fecha_ingreso: new Date().toISOString().split('T')[0]
      }]).select().single();
    if (jugError) throw jugError;

    if (evaluacion && Object.keys(evaluacion).length > 0) {
      await supabase.from('evaluaciones').insert([{ academia_id, jugador_id: jugador.id, fecha_evaluacion: new Date().toISOString(), metricas_json: evaluacion }]);
    }

    if (ficha_medica) {
      await supabase.from('ficha_medica').insert([{ academia_id, jugador_id: jugador.id, tipo_sangre: ficha_medica.tipo_sangre || null, alergias: ficha_medica.alergias || null, enfermedades_cronicas: ficha_medica.enfermedades_cronicas || null, contacto_em_nombre: ficha_medica.contacto_em_nombre || null, contacto_em_telefono: ficha_medica.contacto_em_telefono || null, compromiso_certificado: ficha_medica.compromiso_certificado || false }]);
    }

    if (abono_matricula > 0) {
      await supabase.from('finanzas').insert([{ academia_id, jugador_id: jugador.id, flujo: 'Ingreso', tipo_pago: 'Matrícula', monto: abono_matricula, fecha_pago: new Date().toISOString().split('T')[0], concepto: `Matrícula - ${nombre}`, metodo_pago: 'Efectivo/Transferencia', mes_correspondiente: '-- No Aplica --' }]);
    }

    // F. GENERAR PDF Y ENVIAR CORREO
    if (tutor.email) {
      try {
        const base64Pdf = await generarContratoPDF({
          folio, nombre: jugador.nombre, categoria, posicion_cancha: jugador.posicion_cancha, numero_camiseta: jugador.numero_camiseta, monto_matricula, abono_matricula, monto_mensualidad, tutor
        }, academiaInfo);

        // Envío asíncrono para no bloquear la respuesta HTTP
        enviarCorreoBrevo(tutor.email, tutor.nombre_completo, base64Pdf, folio, jugador.nombre, academiaInfo);
      } catch (pdfError) {
        console.error('❌ Error generando PDF o enviando correo:', pdfError);
      }
    }

    res.status(201).json({ success: true, data: jugador, categoria_asignada: categoria, folio: folio });

  } catch (error) {
    console.error('❌ Error en POST /api/jugadores:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
