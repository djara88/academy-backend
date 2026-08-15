const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { CONSENT_DEFINITIONS, PRIVACY_VERSION, getConsentCatalog } = require('../services/privacyConsents');
const { materializeEnrollment } = require('../services/enrollmentService');
const { selectEnrollmentTerms } = require('../services/premiumPdf');
const { generateSignedEnrollmentPdf } = require('../services/signedEnrollmentPdf');
const { fetchWithTimeout } = require('../services/httpClient');

const FRONTEND_URL = String(process.env.FRONTEND_URL || 'https://academy-frontend-wheat.vercel.app').replace(/\/$/, '');
const TOKEN_TTL_DAYS = Math.max(2, Number(process.env.PREMATRICULA_TTL_DAYS || 7));
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const safeText = (value, max = 5000) => String(value || '').trim().slice(0, max);
const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');

const sendPrematriculaEmail = async ({ academia, tutor, jugador, link }) => {
  if (!tutor?.email || !process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) return false;
  try {
    const response = await fetchWithTimeout('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { accept: 'application/json', 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { name: academia.nombre || 'Academia Deportiva', email: process.env.BREVO_SENDER_EMAIL },
        to: [{ email: tutor.email, name: tutor.nombre_completo || '' }],
        subject: `${academia.nombre || 'Academia'} | Revisa y firma la pre-matrícula de ${jugador.nombre}`,
        htmlContent: `<div style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.6;max-width:640px;margin:auto">
          <h2 style="color:#111827">Pre-matrícula pendiente de tu revisión</h2>
          <p>Hola ${escapeHtml(tutor.nombre_completo || 'apoderado/a')},</p>
          <p><strong>${escapeHtml(academia.nombre || 'la academia')}</strong> preparó la pre-matrícula de <strong>${escapeHtml(jugador.nombre)}</strong>.</p>
          <p>Antes de formalizarla podrás revisar los datos, valores, condiciones de matrícula y decidir por separado cada autorización de privacidad e imagen.</p>
          <p style="margin:28px 0"><a href="${link}" style="display:inline-block;background:#102A43;color:white;text-decoration:none;padding:13px 20px;border-radius:10px;font-weight:700">Revisar y firmar pre-matrícula</a></p>
          <p style="font-size:13px;color:#64748b">Este enlace es personal y vence en ${TOKEN_TTL_DAYS} días. No lo reenvíes a terceros.</p>
        </div>`,
      }),
    }, 10000);
    return response.ok;
  } catch (_error) {
    return false;
  }
};

const sendFinalEnrollmentEmail = async ({ academia, tutor, jugador, folio, pdfBuffer }) => {
  if (!tutor?.email || !process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) return false;
  try {
    const response = await fetchWithTimeout('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { accept: 'application/json', 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { name: academia.nombre || 'Academia Deportiva', email: process.env.BREVO_SENDER_EMAIL },
        to: [{ email: tutor.email, name: tutor.nombre_completo || '' }],
        subject: `${academia.nombre || 'Academia'} | Matrícula firmada ${folio}`,
        htmlContent: `<div style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.6;max-width:640px;margin:auto">
          <h2 style="color:#111827">Matrícula formalizada</h2>
          <p>Hola ${escapeHtml(tutor.nombre_completo || 'apoderado/a')},</p>
          <p>La matrícula de <strong>${escapeHtml(jugador.nombre)}</strong> fue formalizada correctamente.</p>
          <p>Adjuntamos el documento final con el resumen de inscripción y la evidencia de las decisiones registradas.</p>
          <p><strong>Folio:</strong> ${escapeHtml(folio)}</p>
        </div>`,
        attachment: [{ content: pdfBuffer.toString('base64'), name: `Matricula_${folio}.pdf` }],
      }),
    }, 10000);
    return response.ok;
  } catch (_error) {
    return false;
  }
};

router.get('/', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('prematriculas')
    .select('id,estado,expires_at,sent_at,opened_at,signed_at,tutor_payload,jugador_payload,created_at,jugador_id')
    .eq('academia_id', req.user.academia_id).order('created_at', { ascending: false }).limit(100);
  if (error) return res.status(500).json({ success: false, error: 'No fue posible cargar las pre-matrículas.' });
  res.json({ success: true, data });
});

router.post('/', authMiddleware, async (req, res) => {
  try {
    const { academia_id, id: userId } = req.user;
    const tutor = req.body?.tutor || {};
    const jugador = req.body?.jugador || {};
    const finanzas = req.body?.finanzas || {};
    const evaluacion = req.body?.evaluacion || {};
    const emergencia = req.body?.emergencia || {};
    if (!safeText(tutor.nombre_completo, 180) || !safeText(tutor.email, 240) || !safeText(jugador.nombre, 180)) {
      return res.status(400).json({ success: false, error: 'Nombre del alumno, apoderado y correo son obligatorios.' });
    }

    const { data: academia, error: academyError } = await supabase.from('academias').select('*').eq('id', academia_id).single();
    if (academyError || !academia) return res.status(404).json({ success: false, error: 'Academia no encontrada.' });

    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 86400000).toISOString();
    const termsSnapshot = selectEnrollmentTerms(academia) || 'La academia no mantiene condiciones adicionales de matrícula configuradas en Syncademia.';
    const row = {
      academia_id,
      estado: 'enviada',
      token_hash: tokenHash,
      expires_at: expiresAt,
      sent_at: new Date().toISOString(),
      tutor_payload: tutor,
      jugador_payload: jugador,
      finanzas_payload: finanzas,
      evaluacion_payload: evaluacion,
      emergencia_payload: emergencia,
      privacy_version: PRIVACY_VERSION,
      terms_snapshot: termsSnapshot,
      created_by: userId || null,
      updated_at: new Date().toISOString(),
    };
    const { data: created, error } = await supabase.from('prematriculas').insert([row]).select('id,estado,expires_at').single();
    if (error) throw error;

    const link = `${FRONTEND_URL}/prematricula/${token}`;
    const emailSent = await sendPrematriculaEmail({ academia, tutor, jugador, link });
    res.status(201).json({ success: true, data: created, link, email_sent: emailSent });
  } catch (error) {
    console.error('Error creando pre-matrícula:', error?.message || 'Error desconocido');
    res.status(500).json({ success: false, error: 'No fue posible crear la pre-matrícula.' });
  }
});

router.get('/public/:token', async (req, res) => {
  try {
    const tokenHash = hashToken(req.params.token);
    const { data: pre, error } = await supabase.from('prematriculas').select('*').eq('token_hash', tokenHash).maybeSingle();
    if (error || !pre) return res.status(404).json({ success: false, error: 'Enlace de pre-matrícula no válido.' });
    if (new Date(pre.expires_at).getTime() < Date.now() && !['firmada','cancelada'].includes(pre.estado)) {
      await supabase.from('prematriculas').update({ estado: 'vencida', updated_at: new Date().toISOString() }).eq('id', pre.id);
      return res.status(410).json({ success: false, error: 'Este enlace de pre-matrícula ya venció.' });
    }
    if (pre.estado === 'cancelada') return res.status(410).json({ success: false, error: 'Esta pre-matrícula fue cancelada.' });

    const { data: academia } = await supabase.from('academias').select('nombre,logo,logo_url,color_primario,color_secundario,direccion,telefono,director_email').eq('id', pre.academia_id).single();
    if (pre.estado === 'enviada') await supabase.from('prematriculas').update({ estado: 'abierta', opened_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', pre.id).eq('estado', 'enviada');

    res.json({
      success: true,
      data: {
        id: pre.id,
        estado: pre.estado,
        expires_at: pre.expires_at,
        academia,
        tutor: pre.tutor_payload,
        jugador: pre.jugador_payload,
        finanzas: pre.finanzas_payload,
        emergencia: pre.emergencia_payload,
        terms: pre.terms_snapshot,
        privacy: getConsentCatalog(academia?.nombre || 'la academia'),
        signed_at: pre.signed_at,
      },
    });
  } catch (_error) {
    res.status(500).json({ success: false, error: 'No fue posible abrir la pre-matrícula.' });
  }
});

router.post('/public/:token/firmar', async (req, res) => {
  const tokenHash = hashToken(req.params.token);
  let pre = null;
  try {
    const { data, error } = await supabase.from('prematriculas').select('*').eq('token_hash', tokenHash).maybeSingle();
    if (error || !data) return res.status(404).json({ success: false, error: 'Enlace no válido.' });
    pre = data;
    if (pre.estado === 'firmada') return res.status(409).json({ success: false, error: 'Esta pre-matrícula ya fue firmada.' });
    if (!['enviada','abierta'].includes(pre.estado)) return res.status(409).json({ success: false, error: 'Esta pre-matrícula no está disponible para firma.' });
    if (new Date(pre.expires_at).getTime() < Date.now()) return res.status(410).json({ success: false, error: 'El enlace de pre-matrícula venció.' });

    const decisions = req.body?.decisiones || {};
    const acceptsTerms = req.body?.acepta_terminos === true;
    const signedByName = safeText(req.body?.firmante_nombre, 180);
    const signedByDocument = safeText(req.body?.firmante_documento, 80);
    const signature = safeText(req.body?.firma_data_url, 250000);
    if (!acceptsTerms || decisions.aviso_privacidad !== true) return res.status(400).json({ success: false, error: 'Debe aceptar las condiciones de matrícula y confirmar el aviso de privacidad.' });
    if (!signedByName || !signedByDocument || !signature.startsWith('data:image/png;base64,')) return res.status(400).json({ success: false, error: 'Nombre, documento y firma manuscrita son obligatorios.' });

    const { data: locked, error: lockError } = await supabase.from('prematriculas').update({ estado: 'procesando', updated_at: new Date().toISOString() })
      .eq('id', pre.id).in('estado', ['enviada','abierta']).select('id').maybeSingle();
    if (lockError || !locked) return res.status(409).json({ success: false, error: 'La pre-matrícula está siendo procesada o ya cambió de estado.' });

    const consentSnapshot = Object.fromEntries(Object.keys(CONSENT_DEFINITIONS).map((tipo) => [tipo, decisions[tipo] === true]));
    const evidencePayload = JSON.stringify({
      prematricula_id: pre.id,
      academia_id: pre.academia_id,
      tutor: pre.tutor_payload,
      jugador: pre.jugador_payload,
      finanzas: pre.finanzas_payload,
      terms: pre.terms_snapshot,
      terms_accepted: true,
      privacy_version: pre.privacy_version,
      decisions: consentSnapshot,
      signed_by_name: signedByName,
      signed_by_document: signedByDocument,
      signed_at: new Date().toISOString(),
    });
    const evidenceHash = sha256(evidencePayload);

    const playerPayload = { ...(pre.jugador_payload || {}) };
    if (!consentSnapshot.imagen_interna) playerPayload.foto_base64 = '';
    const emergencyPayload = consentSnapshot.datos_salud ? (pre.emergencia_payload || {}) : {};
    const materialized = await materializeEnrollment({
      academiaId: pre.academia_id,
      userId: pre.created_by,
      sourceKey: `prematricula-${pre.id}`,
      payload: { tutor: pre.tutor_payload, jugador: playerPayload, finanzas: pre.finanzas_payload, evaluacion: pre.evaluacion_payload, emergencia: emergencyPayload },
    });

    const now = new Date().toISOString();
    const consentRows = Object.keys(CONSENT_DEFINITIONS).map((tipo) => {
      const definition = CONSENT_DEFINITIONS[tipo];
      const accepted = consentSnapshot[tipo] === true;
      return {
        academia_id: pre.academia_id,
        jugador_id: materialized.jugador.id,
        tutor_id: materialized.tutorId,
        tipo,
        estado: accepted ? 'aceptado' : 'rechazado',
        obligatorio: definition.obligatorio,
        version: pre.privacy_version,
        finalidad: definition.finalidad,
        contenido_snapshot: definition.contenido,
        representante_nombre: signedByName,
        canal: 'prematricula_digital',
        registrado_por: pre.created_by || null,
        otorgado_at: accepted ? now : null,
        revocado_at: null,
      };
    });
    const { error: consentError } = await supabase.from('consentimientos_alumnos').upsert(consentRows, { onConflict: 'jugador_id,tipo,version', ignoreDuplicates: false });
    if (consentError) throw consentError;

    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 80) || null;
    await supabase.from('jugadores').update({
      terminos_aceptados: true,
      fecha_aceptacion_terminos: now,
      terminos_condiciones: pre.terms_snapshot,
      firma_digital: signature,
      ip_aceptacion: ip,
    }).eq('id', materialized.jugador.id).eq('academia_id', pre.academia_id);

    const { data: academia } = await supabase.from('academias').select('*').eq('id', pre.academia_id).single();
    const { data: tutor } = await supabase.from('tutores').select('*').eq('id', materialized.tutorId).single();
    const folio = `MAT-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
    const pdfBuffer = await generateSignedEnrollmentPdf({
      academia,
      jugador: materialized.jugador,
      tutor,
      folio,
      terms: pre.terms_snapshot,
      consentimientos: consentRows,
      firma: { nombre: signedByName, documento: signedByDocument, fecha: now, ip, evidence_sha256: evidenceHash, data_url: signature },
    });
    const documentHash = sha256(pdfBuffer);
    const fileName = `${pre.academia_id}/${folio}.pdf`;
    const { error: uploadError } = await supabase.storage.from('matriculas-pdf').upload(fileName, pdfBuffer, { contentType: 'application/pdf', upsert: false });
    if (uploadError) throw uploadError;
    const { data: signedUrlData, error: signedError } = await supabase.storage.from('matriculas-pdf').createSignedUrl(fileName, 15 * 60);
    if (signedError) throw signedError;
    const emailSent = await sendFinalEnrollmentEmail({ academia, tutor, jugador: materialized.jugador, folio, pdfBuffer });

    await supabase.from('prematriculas').update({
      estado: 'firmada', signed_at: now, signed_by_name: signedByName, signed_by_document: signedByDocument,
      signed_ip: ip || null, signed_user_agent: safeText(req.headers['user-agent'], 500), signature_data_url: signature,
      consent_snapshot: consentSnapshot, evidence_sha256: evidenceHash, final_document_path: fileName,
      final_document_sha256: documentHash, jugador_id: materialized.jugador.id, tutor_id: materialized.tutorId, updated_at: now,
    }).eq('id', pre.id);

    res.status(201).json({ success: true, folio, url: signedUrlData.signedUrl, email_sent: emailSent, jugador_id: materialized.jugador.id });
  } catch (error) {
    if (pre?.id) await supabase.from('prematriculas').update({ estado: 'error', updated_at: new Date().toISOString() }).eq('id', pre.id).eq('estado', 'procesando');
    console.error('Error formalizando pre-matrícula:', error?.message || 'Error desconocido');
    res.status(500).json({ success: false, error: 'No fue posible formalizar la pre-matrícula. La academia puede reintentar el proceso.' });
  }
});

module.exports = router;
