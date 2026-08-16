const express = require('express');
const crypto = require('crypto');
const sharp = require('sharp');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { PRIVACY_VERSION, getConsentCatalog } = require('../services/privacyConsents');
const { materializeEnrollment, cleanupMaterializedEnrollment } = require('../services/enrollmentService');
const { selectEnrollmentTerms } = require('../services/premiumPdf');
const { generateSignedEnrollmentPdf } = require('../services/signedEnrollmentPdf');
const { fetchWithTimeout } = require('../services/httpClient');

const FRONTEND_URL = String(process.env.FRONTEND_URL || 'https://academy-frontend-wheat.vercel.app').replace(/\/$/, '');
const TOKEN_TTL_DAYS = Math.max(2, Number(process.env.PREMATRICULA_TTL_DAYS || 7));
const MAX_PUBLIC_PHOTO_DATA_URL_CHARS = 1800000;
const MAX_PUBLIC_PHOTO_SOURCE_BYTES = 1400000;
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const safeText = (value, max = 5000) => String(value || '').trim().slice(0, max);
const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

const photoInputError = (message, code) => Object.assign(new Error(message), { code });
const normalizeStudentPhoto = async (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length > MAX_PUBLIC_PHOTO_DATA_URL_CHARS) {
    throw photoInputError('La fotografía es demasiado pesada. Vuelve a tomarla o elige una imagen más liviana.', 'PHOTO_TOO_LARGE');
  }
  const match = raw.match(/^data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) throw photoInputError('La fotografía debe ser una imagen JPG, PNG o WEBP válida.', 'PHOTO_INVALID');

  const source = Buffer.from(match[1], 'base64');
  if (!source.length) throw photoInputError('La fotografía está vacía o dañada.', 'PHOTO_INVALID');
  if (source.length > MAX_PUBLIC_PHOTO_SOURCE_BYTES) {
    throw photoInputError('La fotografía es demasiado pesada. Vuelve a tomarla o elige una imagen más liviana.', 'PHOTO_TOO_LARGE');
  }

  try {
    const normalized = await sharp(source, { failOn: 'error' })
      .rotate()
      .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    return `data:image/jpeg;base64,${normalized.toString('base64')}`;
  } catch (_error) {
    throw photoInputError('No fue posible validar la fotografía seleccionada.', 'PHOTO_INVALID');
  }
};

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
    .eq('academia_id', req.user.academia_id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ success: false, error: 'No fue posible cargar las pre-matrículas.' });
  return res.json({ success: true, data });
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
    const consentCatalog = getConsentCatalog(academia?.nombre || 'la academia');

    const { data: created, error } = await supabase.from('prematriculas').insert([{
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
      consent_snapshot: consentCatalog,
      created_by: userId || null,
      updated_at: new Date().toISOString(),
    }]).select('id,estado,expires_at').single();
    if (error) throw error;

    const link = `${FRONTEND_URL}/prematricula/${token}`;
    const emailSent = await sendPrematriculaEmail({ academia, tutor, jugador, link });
    return res.status(201).json({ success: true, data: created, link, email_sent: emailSent });
  } catch (error) {
    console.error('Error creando pre-matrícula:', error?.message || 'Error desconocido');
    return res.status(500).json({ success: false, error: 'No fue posible crear la pre-matrícula.' });
  }
});

router.get('/public/:token', async (req, res) => {
  try {
    const tokenHash = hashToken(req.params.token);
    const { data: pre, error } = await supabase.from('prematriculas').select('*').eq('token_hash', tokenHash).maybeSingle();
    if (error || !pre) return res.status(404).json({ success: false, error: 'Enlace de pre-matrícula no válido.' });

    if (new Date(pre.expires_at).getTime() < Date.now() && !['firmada', 'cancelada'].includes(pre.estado)) {
      await supabase.from('prematriculas').update({ estado: 'vencida', updated_at: new Date().toISOString() }).eq('id', pre.id);
      return res.status(410).json({ success: false, error: 'Este enlace de pre-matrícula ya venció.' });
    }
    if (pre.estado === 'cancelada') return res.status(410).json({ success: false, error: 'Esta pre-matrícula fue cancelada.' });

    const { data: academia } = await supabase.from('academias')
      .select('nombre,logo,logo_url,color_primario,color_secundario,direccion,telefono,director_email')
      .eq('id', pre.academia_id).single();

    if (pre.estado === 'enviada') {
      await supabase.from('prematriculas').update({
        estado: 'abierta', opened_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq('id', pre.id).eq('estado', 'enviada');
    }

    return res.json({
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
        privacy: pre.consent_snapshot?.items ? pre.consent_snapshot : getConsentCatalog(academia?.nombre || 'la academia'),
        signed_at: pre.signed_at,
      },
    });
  } catch (_error) {
    return res.status(500).json({ success: false, error: 'No fue posible abrir la pre-matrícula.' });
  }
});

router.post('/public/:token/firmar', async (req, res) => {
  const tokenHash = hashToken(req.params.token);
  let pre = null;
  let materialized = null;
  let uploadedPath = null;
  let finalized = false;

  try {
    const { data, error } = await supabase.from('prematriculas').select('*').eq('token_hash', tokenHash).maybeSingle();
    if (error || !data) return res.status(404).json({ success: false, error: 'Enlace no válido.' });
    pre = data;

    if (pre.estado === 'firmada') return res.status(409).json({ success: false, error: 'Esta pre-matrícula ya fue firmada.' });
    if (!['enviada', 'abierta'].includes(pre.estado)) return res.status(409).json({ success: false, error: 'Esta pre-matrícula no está disponible para firma.' });
    if (new Date(pre.expires_at).getTime() < Date.now()) return res.status(410).json({ success: false, error: 'El enlace de pre-matrícula venció.' });

    const decisions = req.body?.decisiones || {};
    const acceptsTerms = req.body?.acepta_terminos === true;
    const signedByName = safeText(req.body?.firmante_nombre, 180);
    const signedByDocument = safeText(req.body?.firmante_documento, 80);
    const signature = safeText(req.body?.firma_data_url, 250000);
    const requestedStudentPhoto = String(req.body?.foto_alumno_data_url || '').trim();

    if (!acceptsTerms || decisions.aviso_privacidad !== true) {
      return res.status(400).json({ success: false, error: 'Debe aceptar las condiciones de matrícula y confirmar el aviso de privacidad.' });
    }
    if (!signedByName || !signedByDocument || !signature.startsWith('data:image/png;base64,')) {
      return res.status(400).json({ success: false, error: 'Nombre, documento y firma manuscrita son obligatorios.' });
    }

    let normalizedStudentPhoto = '';
    if (decisions.imagen_interna === true) {
      if (!requestedStudentPhoto) {
        return res.status(400).json({ success: false, code: 'PHOTO_REQUIRED', error: 'Agrega la foto del alumno antes de firmar.' });
      }
      try {
        normalizedStudentPhoto = await normalizeStudentPhoto(requestedStudentPhoto);
      } catch (photoError) {
        const status = photoError?.code === 'PHOTO_TOO_LARGE' ? 413 : 400;
        return res.status(status).json({ success: false, code: photoError?.code || 'PHOTO_INVALID', error: photoError?.message || 'La fotografía no es válida.' });
      }
    }

    const { data: locked, error: lockError } = await supabase.from('prematriculas')
      .update({ estado: 'procesando', updated_at: new Date().toISOString() })
      .eq('id', pre.id)
      .in('estado', ['enviada', 'abierta'])
      .select('id')
      .maybeSingle();
    if (lockError || !locked) return res.status(409).json({ success: false, error: 'La pre-matrícula está siendo procesada o ya cambió de estado.' });

    const catalog = pre.consent_snapshot?.items ? pre.consent_snapshot : getConsentCatalog('la academia');
    const catalogItems = Array.isArray(catalog.items) ? catalog.items : [];
    const mandatoryMissing = catalogItems.some((item) => item.obligatorio === true && decisions[item.tipo] !== true);
    if (mandatoryMissing) throw Object.assign(new Error('Falta confirmar una autorización obligatoria.'), { code: 'MANDATORY_CONSENT_MISSING' });

    const consentDecisions = Object.fromEntries(catalogItems.map((item) => [item.tipo, decisions[item.tipo] === true]));
    if (consentDecisions.imagen_interna === true && !normalizedStudentPhoto) {
      throw photoInputError('Agrega la foto del alumno antes de firmar.', 'PHOTO_REQUIRED');
    }
    if (consentDecisions.imagen_interna !== true) normalizedStudentPhoto = '';

    const signedAt = new Date().toISOString();
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 80) || null;
    const userAgent = safeText(req.headers['user-agent'], 500);
    const photoHash = normalizedStudentPhoto ? sha256(normalizedStudentPhoto) : null;
    const evidencePayload = JSON.stringify({
      prematricula_id: pre.id,
      academia_id: pre.academia_id,
      tutor: pre.tutor_payload,
      jugador: pre.jugador_payload,
      finanzas: pre.finanzas_payload,
      terms: pre.terms_snapshot,
      terms_accepted: true,
      consent_catalog: catalog,
      decisions: consentDecisions,
      student_photo: {
        included: Boolean(normalizedStudentPhoto),
        source: normalizedStudentPhoto ? 'apoderado_firma' : null,
        sha256: photoHash,
      },
      signed_by_name: signedByName,
      signed_by_document: signedByDocument,
      signed_at: signedAt,
      ip,
      user_agent: userAgent,
    });
    const evidenceHash = sha256(evidencePayload);

    const playerPayload = { ...(pre.jugador_payload || {}) };
    delete playerPayload.foto_base64;
    delete playerPayload.foto_url;
    delete playerPayload.avatar_url;
    if (consentDecisions.imagen_interna && normalizedStudentPhoto) playerPayload.foto_base64 = normalizedStudentPhoto;
    const emergencyPayload = consentDecisions.datos_salud ? (pre.emergencia_payload || {}) : {};

    materialized = await materializeEnrollment({
      academiaId: pre.academia_id,
      userId: pre.created_by,
      sourceKey: `prematricula-${pre.id}`,
      payload: {
        tutor: pre.tutor_payload,
        jugador: playerPayload,
        finanzas: pre.finanzas_payload,
        evaluacion: pre.evaluacion_payload,
        emergencia: emergencyPayload,
      },
    });

    const consentRows = catalogItems.map((definition) => {
      const accepted = consentDecisions[definition.tipo] === true;
      return {
        academia_id: pre.academia_id,
        jugador_id: materialized.jugador.id,
        tutor_id: materialized.tutorId,
        tipo: definition.tipo,
        estado: accepted ? 'aceptado' : 'rechazado',
        obligatorio: definition.obligatorio === true,
        version: pre.privacy_version,
        finalidad: definition.finalidad,
        contenido_snapshot: definition.contenido,
        representante_nombre: signedByName,
        canal: 'prematricula_digital',
        registrado_por: pre.created_by || null,
        otorgado_at: accepted ? signedAt : null,
        revocado_at: null,
      };
    });

    const { error: consentError } = await supabase.from('consentimientos_alumnos')
      .upsert(consentRows, { onConflict: 'jugador_id,tipo,version', ignoreDuplicates: false });
    if (consentError) throw consentError;

    const { error: playerEvidenceError } = await supabase.from('jugadores').update({
      terminos_aceptados: true,
      fecha_aceptacion_terminos: signedAt,
      terminos_condiciones: pre.terms_snapshot,
      firma_digital: signature,
      ip_aceptacion: ip,
    }).eq('id', materialized.jugador.id).eq('academia_id', pre.academia_id);
    if (playerEvidenceError) throw playerEvidenceError;

    const [academyResult, tutorResult] = await Promise.all([
      supabase.from('academias').select('*').eq('id', pre.academia_id).single(),
      supabase.from('tutores').select('*').eq('id', materialized.tutorId).single(),
    ]);
    if (academyResult.error || tutorResult.error || !academyResult.data || !tutorResult.data) {
      throw academyResult.error || tutorResult.error || new Error('No fue posible cargar los datos finales de matrícula.');
    }
    const academia = academyResult.data;
    const tutor = tutorResult.data;

    const folio = `MAT-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
    const pdfBuffer = await generateSignedEnrollmentPdf({
      academia,
      jugador: materialized.jugador,
      tutor,
      folio,
      terms: pre.terms_snapshot,
      consentimientos: consentRows,
      firma: {
        nombre: signedByName,
        documento: signedByDocument,
        fecha: signedAt,
        ip,
        evidence_sha256: evidenceHash,
        data_url: signature,
      },
    });
    const documentHash = sha256(pdfBuffer);
    const fileName = `${pre.academia_id}/${folio}.pdf`;

    const { error: uploadError } = await supabase.storage.from('matriculas-pdf')
      .upload(fileName, pdfBuffer, { contentType: 'application/pdf', upsert: false });
    if (uploadError) throw uploadError;
    uploadedPath = fileName;

    const { data: signedUrlData, error: signedError } = await supabase.storage.from('matriculas-pdf')
      .createSignedUrl(fileName, 15 * 60);
    if (signedError || !signedUrlData?.signedUrl) throw signedError || new Error('No fue posible crear el enlace seguro.');

    const finalConsentSnapshot = {
      ...catalog,
      decisions: consentDecisions,
      photo_evidence: {
        included: Boolean(normalizedStudentPhoto),
        source: normalizedStudentPhoto ? 'apoderado_firma' : null,
        sha256: photoHash,
        captured_at: normalizedStudentPhoto ? signedAt : null,
      },
    };
    const { data: finalizedRow, error: finalError } = await supabase.from('prematriculas').update({
      estado: 'firmada',
      signed_at: signedAt,
      signed_by_name: signedByName,
      signed_by_document: signedByDocument,
      signed_ip: ip || null,
      signed_user_agent: userAgent,
      signature_data_url: signature,
      consent_snapshot: finalConsentSnapshot,
      evidence_sha256: evidenceHash,
      final_document_path: fileName,
      final_document_sha256: documentHash,
      jugador_id: materialized.jugador.id,
      tutor_id: materialized.tutorId,
      updated_at: signedAt,
    }).eq('id', pre.id).eq('estado', 'procesando').select('id').maybeSingle();
    if (finalError || !finalizedRow) throw finalError || new Error('No fue posible confirmar el cierre de la pre-matrícula.');
    finalized = true;

    const emailSent = await sendFinalEnrollmentEmail({ academia, tutor, jugador: materialized.jugador, folio, pdfBuffer });
    return res.status(201).json({
      success: true,
      folio,
      url: signedUrlData.signedUrl,
      email_sent: emailSent,
      jugador_id: materialized.jugador.id,
      photo_saved: Boolean(normalizedStudentPhoto),
      evidence_sha256: evidenceHash,
    });
  } catch (error) {
    if (!finalized && uploadedPath) {
      await supabase.storage.from('matriculas-pdf').remove([uploadedPath]);
    }
    if (!finalized && materialized?.jugador?.id && pre?.academia_id) {
      await cleanupMaterializedEnrollment({
        academiaId: pre.academia_id,
        jugadorId: materialized.jugador.id,
        tutorId: materialized.tutorId,
        tutorWasCreated: materialized.tutorWasCreated,
      });
    }

    const permanent = error?.code === 'PLAYER_ALREADY_EXISTS';
    if (pre?.id && !finalized) {
      await supabase.from('prematriculas').update({
        estado: permanent ? 'error' : 'abierta',
        updated_at: new Date().toISOString(),
      }).eq('id', pre.id).eq('estado', 'procesando');
    }

    console.error('Error formalizando pre-matrícula:', error?.message || 'Error desconocido');
    if (error?.code === 'PLAYER_LIMIT_REACHED') return res.status(403).json({ success: false, code: error.code, error: error.message });
    if (error?.code === 'PLAYER_ALREADY_EXISTS') return res.status(409).json({ success: false, code: error.code, error: error.message });
    if (error?.code === 'MANDATORY_CONSENT_MISSING') return res.status(400).json({ success: false, code: error.code, error: error.message });
    if (error?.code === 'PHOTO_REQUIRED' || error?.code === 'PHOTO_INVALID') return res.status(400).json({ success: false, code: error.code, error: error.message });
    if (error?.code === 'PHOTO_TOO_LARGE') return res.status(413).json({ success: false, code: error.code, error: error.message });
    return res.status(500).json({ success: false, error: 'No fue posible formalizar la pre-matrícula. Puedes reintentar sin crear registros duplicados.' });
  }
});

module.exports = router;
