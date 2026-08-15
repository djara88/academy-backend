const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { generateMatriculaPdf } = require('../services/premiumPdf');
const { fetchWithTimeout } = require('../services/httpClient');

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

router.post('/generar-documento', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { jugador_id, tutor_id } = req.body || {};

    if (!academia_id || !jugador_id || !tutor_id) {
      return res.status(400).json({ success: false, error: 'Faltan datos para generar la matrícula.' });
    }

    const [academiaResult, jugadorResult, tutorResult, consentResult] = await Promise.all([
      supabase.from('academias').select('*').eq('id', academia_id).maybeSingle(),
      supabase.from('jugadores').select('*').eq('id', jugador_id).eq('academia_id', academia_id).maybeSingle(),
      supabase.from('tutores').select('*').eq('id', tutor_id).eq('academia_id', academia_id).maybeSingle(),
      supabase.from('consentimientos_alumnos')
        .select('tipo,estado,version,finalidad,obligatorio,otorgado_at,revocado_at,created_at')
        .eq('academia_id', academia_id)
        .eq('jugador_id', jugador_id)
        .order('created_at', { ascending: false }),
    ]);

    if (academiaResult.error || jugadorResult.error || tutorResult.error || consentResult.error) {
      throw new Error('No fue posible validar la información asociada a la matrícula.');
    }

    const academia = academiaResult.data;
    const jugador = jugadorResult.data;
    const tutor = tutorResult.data;
    if (!academia || !jugador || !tutor) {
      return res.status(404).json({ success: false, error: 'Jugador o apoderado no pertenece a la academia autenticada.' });
    }

    const privacyAccepted = (consentResult.data || []).some((row) => row.tipo === 'aviso_privacidad' && row.estado === 'aceptado');
    if (!privacyAccepted) {
      return res.status(409).json({ success: false, error: 'Debe registrarse el aviso de privacidad antes de emitir la matrícula.' });
    }

    const folio = `MAT-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
    const pdfBuffer = await generateMatriculaPdf({
      academia,
      jugador,
      tutor,
      folio,
      consentimientos: consentResult.data || [],
    });

    const fileName = `${academia_id}/${folio}.pdf`;
    const { error: uploadError } = await supabase.storage.from('matriculas-pdf')
      .upload(fileName, pdfBuffer, { contentType: 'application/pdf', upsert: false });
    if (uploadError) throw uploadError;

    const { data: signedData, error: signedError } = await supabase.storage.from('matriculas-pdf')
      .createSignedUrl(fileName, 15 * 60);
    if (signedError || !signedData?.signedUrl) throw new Error('No fue posible generar el enlace seguro del documento.');

    let emailSent = false;
    if (process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL && tutor.email) {
      const emailResponse = await fetchWithTimeout('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'api-key': process.env.BREVO_API_KEY,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sender: { name: academia.nombre || 'Academia Deportiva', email: process.env.BREVO_SENDER_EMAIL },
          to: [{ email: tutor.email, name: tutor.nombre_completo || tutor.nombre || '' }],
          subject: `${academia.nombre || 'Academia'} | Matrícula ${folio}`,
          htmlContent: `
            <div style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.6;max-width:640px;margin:auto">
              <h2 style="color:#111827">Bienvenido/a a ${escapeHtml(academia.nombre || 'nuestra academia')}</h2>
              <p>Hola ${escapeHtml(tutor.nombre_completo || tutor.nombre || 'apoderado/a')},</p>
              <p>La matrícula de <strong>${escapeHtml(jugador.nombre)}</strong> fue registrada correctamente.</p>
              <p>Adjuntamos el documento oficial con el folio <strong>${escapeHtml(folio)}</strong>, el resumen de inscripción, información práctica, términos y el registro de autorizaciones entregadas durante la matrícula.</p>
              <p style="margin-top:24px">Gracias por confiar en nuestro proyecto deportivo.</p>
              <p><strong>${escapeHtml(academia.nombre || 'Academia Deportiva')}</strong></p>
            </div>`,
          attachment: [{ content: pdfBuffer.toString('base64'), name: `Matricula_${folio}.pdf` }],
        }),
      }, 10000);
      emailSent = emailResponse.ok;
      if (!emailResponse.ok) console.warn(`Brevo rechazó correo de matrícula (HTTP ${emailResponse.status}).`);
    }

    res.status(201).json({
      success: true,
      url: signedData.signedUrl,
      folio,
      email_sent: emailSent,
      url_expires_in_seconds: 900,
    });
  } catch (error) {
    console.error('Error generando matrícula premium:', error?.message || 'error interno');
    res.status(500).json({ success: false, error: 'No fue posible generar la matrícula.' });
  }
});

module.exports = router;
