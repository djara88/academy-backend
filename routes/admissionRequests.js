const express = require('express');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { PRIVACY_VERSION, getConsentCatalog } = require('../services/privacyConsents');
const { selectEnrollmentTerms } = require('../services/premiumPdf');
const { fetchWithTimeout } = require('../services/httpClient');
const { getAcademyEntitlements } = require('../services/planCatalog');
const { assertRutAvailable } = require('../services/rutGuard');

const router = express.Router();
const FRONTEND_URL = String(process.env.FRONTEND_URL || 'https://lestra.app').replace(/\/$/, '');
const TOKEN_TTL_DAYS = Math.max(2, Number(process.env.PREMATRICULA_TTL_DAYS || 7));
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const safeText = (value, max = 500) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const normalizePhone = (value) => safeText(value, 40).replace(/[^0-9+]/g, '');
const validEmail = (value) => !value || /^\S+@\S+\.\S+$/.test(String(value).trim());
const validDate = (value) => {
  if (!value) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : String(value).slice(0, 10);
};

const sendDirectorNotice = async ({ academy, lead }) => {
  const email = academy.correo_academia || academy.director_email;
  if (!email || !process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) return false;
  try {
    const response = await fetchWithTimeout('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { accept: 'application/json', 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'Lestra', email: process.env.BREVO_SENDER_EMAIL },
        to: [{ email, name: academy.nombre || 'Dirección' }],
        subject: `${academy.nombre || 'Academia'} | Nueva solicitud de inscripción`,
        htmlContent: `<div style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.6"><h2>Nueva solicitud desde tu página pública</h2><p><b>Alumno:</b> ${escapeHtml(lead.alumno_nombre)}</p><p><b>Apoderado:</b> ${escapeHtml(lead.apoderado_nombre)}</p><p><b>Teléfono:</b> ${escapeHtml(lead.telefono)}</p><p>Ingresa a Lestra → Solicitudes para gestionarla.</p></div>`,
      }),
    }, 10000);
    return response.ok;
  } catch (_error) {
    return false;
  }
};

const sendPrematriculaEmail = async ({ academy, tutor, student, link }) => {
  if (!tutor.email || !process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) return false;
  try {
    const response = await fetchWithTimeout('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { accept: 'application/json', 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { name: academy.nombre || 'Academia Deportiva', email: process.env.BREVO_SENDER_EMAIL },
        to: [{ email: tutor.email, name: tutor.nombre_completo || '' }],
        subject: `${academy.nombre || 'Academia'} | Revisa y firma la pre-matrícula de ${student.nombre}`,
        htmlContent: `<div style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.6;max-width:640px;margin:auto"><h2>Tu solicitud avanzó a pre-matrícula</h2><p>Hola ${escapeHtml(tutor.nombre_completo || 'apoderado/a')},</p><p><b>${escapeHtml(academy.nombre || 'La academia')}</b> preparó la pre-matrícula de <b>${escapeHtml(student.nombre)}</b>.</p><p style="margin:28px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#102A43;color:white;text-decoration:none;padding:13px 20px;border-radius:10px;font-weight:700">Revisar y firmar pre-matrícula</a></p><p style="font-size:13px;color:#64748b">El enlace es personal y vence en ${TOKEN_TTL_DAYS} días.</p></div>`,
      }),
    }, 10000);
    return response.ok;
  } catch (_error) {
    return false;
  }
};

router.post('/public/:slug', async (req, res) => {
  try {
    if (safeText(req.body?.website, 100)) return res.status(200).json({ success: true });
    const slug = safeText(req.params.slug, 80).toLowerCase();
    const apoderadoNombre = safeText(req.body?.apoderado_nombre, 180);
    const alumnoNombre = safeText(req.body?.alumno_nombre, 180);
    const telefono = normalizePhone(req.body?.telefono);
    const email = safeText(req.body?.email, 240).toLowerCase();
    const fechaNacimiento = validDate(req.body?.fecha_nacimiento);
    const mensaje = safeText(req.body?.mensaje, 1200) || null;
    const ramaId = safeText(req.body?.rama_id, 80) || null;
    const categoriaId = safeText(req.body?.categoria_id, 80) || null;

    if (!apoderadoNombre || !alumnoNombre || telefono.replace(/\D/g, '').length < 8) {
      return res.status(400).json({ error: 'Completa nombre del apoderado, nombre del alumno y un teléfono válido.' });
    }
    if (!validEmail(email)) return res.status(400).json({ error: 'El correo ingresado no es válido.' });
    if (req.body?.consentimiento_contacto !== true) return res.status(400).json({ error: 'Debes autorizar que la academia te contacte por esta solicitud.' });

    const { data: academy, error: academyError } = await supabase.from('academias')
      .select('id,nombre,subdominio,pagina_publica_activa,estado,correo_academia,director_email')
      .ilike('subdominio', slug).maybeSingle();
    if (academyError) throw academyError;
    if (!academy || academy.pagina_publica_activa !== true || String(academy.estado || '').toLowerCase() === 'inactiva') {
      return res.status(404).json({ error: 'Academia no disponible.' });
    }

    let branch = null;
    let category = null;
    if (ramaId) {
      const result = await supabase.from('ramas').select('id,sede_id,nombre,disciplina').eq('id', ramaId).eq('academia_id', academy.id).eq('activa', true).maybeSingle();
      if (result.error) throw result.error;
      branch = result.data;
      if (!branch) return res.status(400).json({ error: 'La disciplina seleccionada ya no está disponible.' });
    }
    if (categoriaId) {
      const result = await supabase.from('categorias').select('id,rama_id,nombre').eq('id', categoriaId).eq('academia_id', academy.id).maybeSingle();
      if (result.error) throw result.error;
      category = result.data;
      if (!category || (ramaId && String(category.rama_id) !== String(ramaId))) return res.status(400).json({ error: 'La categoría seleccionada no corresponde a la disciplina.' });
    }

    const duplicateSince = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: duplicate } = await supabase.from('solicitudes_admision').select('id')
      .eq('academia_id', academy.id).eq('telefono', telefono).ilike('alumno_nombre', alumnoNombre)
      .gte('created_at', duplicateSince).limit(1).maybeSingle();
    if (duplicate) return res.status(200).json({ success: true, message: 'Tu solicitud ya fue recibida.' });

    const { data: lead, error } = await supabase.from('solicitudes_admision').insert({
      academia_id: academy.id,
      sede_id: branch?.sede_id || null,
      rama_id: branch?.id || null,
      categoria_id: category?.id || null,
      apoderado_nombre: apoderadoNombre,
      telefono,
      email: email || null,
      alumno_nombre: alumnoNombre,
      fecha_nacimiento: fechaNacimiento,
      mensaje,
      consentimiento_contacto: true,
      estado: 'nueva',
      origen: 'pagina_publica',
    }).select('id,alumno_nombre,apoderado_nombre,telefono').single();
    if (error) throw error;
    void sendDirectorNotice({ academy, lead });
    return res.status(201).json({ success: true, message: 'Solicitud recibida. La academia podrá contactarte para continuar.' });
  } catch (error) {
    console.error('Error creando solicitud pública de admisión:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible enviar la solicitud. Intenta nuevamente.' });
  }
});

router.use(authMiddleware, requireDirector);

router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase.from('solicitudes_admision')
      .select('id,estado,apoderado_nombre,telefono,email,alumno_nombre,fecha_nacimiento,mensaje,consentimiento_contacto,created_at,updated_at,prematricula_id,sede_id,rama_id,categoria_id,sedes(nombre),ramas(nombre,disciplina),categorias(nombre),prematriculas(estado,expires_at,sent_at,signed_at)')
      .eq('academia_id', req.user.academia_id).order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (error) {
    console.error('Error cargando solicitudes de admisión:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible cargar las solicitudes.' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const allowed = new Set(['nueva', 'contactada', 'en_revision', 'archivada']);
    const estado = safeText(req.body?.estado, 30);
    if (!allowed.has(estado)) return res.status(400).json({ error: 'Estado no permitido.' });
    const { data, error } = await supabase.from('solicitudes_admision').update({
      estado,
      gestionado_por: req.user.id || null,
      gestionado_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', req.params.id).eq('academia_id', req.user.academia_id).select('id,estado').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error actualizando solicitud de admisión:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible actualizar la solicitud.' });
  }
});

router.post('/:id/prematricula', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const { data: lead, error: leadError } = await supabase.from('solicitudes_admision')
      .select('*').eq('id', req.params.id).eq('academia_id', academyId).maybeSingle();
    if (leadError) throw leadError;
    if (!lead) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    if (lead.prematricula_id) return res.status(409).json({ error: 'Esta solicitud ya fue convertida en pre-matrícula.' });

    const email = safeText(req.body?.email || lead.email, 240).toLowerCase();
    const tutorRut = safeText(req.body?.rut_apoderado, 40);
    const fechaNacimiento = validDate(req.body?.fecha_nacimiento || lead.fecha_nacimiento);
    const sexo = safeText(req.body?.sexo, 30);
    const alumnoRut = safeText(req.body?.rut_alumno, 40) || null;
    const branchId = safeText(req.body?.rama_id || lead.rama_id, 80) || null;
    const siteId = safeText(req.body?.sede_id || lead.sede_id, 80) || null;

    if (!email || !validEmail(email) || !tutorRut || !fechaNacimiento || !sexo || !branchId || !siteId) {
      return res.status(400).json({ error: 'Completa correo, documento del apoderado, fecha de nacimiento, sexo, sede y disciplina antes de enviar la pre-matrícula.' });
    }

    const [{ data: academy, error: academyError }, { count, error: countError }, { data: branch, error: branchError }] = await Promise.all([
      supabase.from('academias').select('*').eq('id', academyId).single(),
      supabase.from('jugadores').select('id', { count: 'exact', head: true }).eq('academia_id', academyId),
      supabase.from('ramas').select('id,sede_id,activa').eq('id', branchId).eq('academia_id', academyId).maybeSingle(),
    ]);
    if (academyError || countError || branchError) throw academyError || countError || branchError;
    if (!branch?.activa || String(branch.sede_id) !== String(siteId)) return res.status(409).json({ error: 'La sede o disciplina ya no está disponible en el plan actual.' });

    if (lead.categoria_id) {
      const { data: category, error: categoryError } = await supabase.from('categorias')
        .select('id,sede_id,rama_id').eq('id', lead.categoria_id).eq('academia_id', academyId).maybeSingle();
      if (categoryError) throw categoryError;
      if (!category || String(category.sede_id) !== String(siteId) || String(category.rama_id) !== String(branchId)) {
        return res.status(409).json({ error: 'La categoría solicitada ya no corresponde a la sede o disciplina seleccionada. Revisa la solicitud antes de continuar.' });
      }
    }

    if (alumnoRut) await assertRutAvailable({ supabase, academiaId: academyId, rut: alumnoRut });

    const limit = getAcademyEntitlements(academy).limits.players;
    if (Number.isInteger(limit) && Number(count || 0) >= limit) return res.status(403).json({ error: 'La academia alcanzó el límite de alumnos de su plan. Debes ampliar el plan antes de formalizar una nueva inscripción.', code: 'PLAYER_LIMIT_REACHED' });

    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 86400000).toISOString();
    const tutor = { nombre_completo: lead.apoderado_nombre, rut: tutorRut, telefono: lead.telefono, email };
    const student = {
      nombre: lead.alumno_nombre,
      rut: alumnoRut,
      fecha_nacimiento: fechaNacimiento,
      sexo,
      sede_id: siteId,
      rama_id: branchId,
      categoria_id: lead.categoria_id || null,
      tipo_alumno: 'Nuevo',
      certificado_medico: 'Pendiente',
      talla_apoderado: 'No desea',
      monto_camiseta_apoderado: 0,
    };
    const finances = {
      monto_matricula: Math.max(0, Number(req.body?.monto_matricula || 0)),
      abono_matricula: Math.max(0, Number(req.body?.abono_matricula || 0)),
      monto_mensualidad: Math.max(0, Number(req.body?.monto_mensualidad || 0)),
    };
    const termsSnapshot = selectEnrollmentTerms(academy) || 'La academia no mantiene condiciones adicionales de matrícula configuradas.';
    const consentCatalog = getConsentCatalog(academy.nombre || 'la academia');

    const { data: pre, error: preError } = await supabase.from('prematriculas').insert({
      academia_id: academyId,
      sede_id: siteId,
      rama_id: branchId,
      estado: 'enviada',
      token_hash: hashToken(token),
      expires_at: expiresAt,
      sent_at: new Date().toISOString(),
      tutor_payload: tutor,
      jugador_payload: student,
      finanzas_payload: finances,
      evaluacion_payload: {},
      emergencia_payload: {},
      privacy_version: PRIVACY_VERSION,
      terms_snapshot: termsSnapshot,
      consent_snapshot: consentCatalog,
      created_by: req.user.id || null,
      updated_at: new Date().toISOString(),
    }).select('id,estado,expires_at').single();
    if (preError) throw preError;

    const link = `${FRONTEND_URL}/prematricula/${token}`;
    const emailSent = await sendPrematriculaEmail({ academy, tutor, student, link });
    const { error: updateError } = await supabase.from('solicitudes_admision').update({
      estado: 'prematricula',
      prematricula_id: pre.id,
      gestionado_por: req.user.id || null,
      gestionado_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', lead.id).eq('academia_id', academyId);
    if (updateError) throw updateError;

    return res.status(201).json({ success: true, data: pre, link, email_sent: emailSent });
  } catch (error) {
    console.error('Error convirtiendo solicitud a pre-matrícula:', error?.message || error);
    if (['PLAYER_RUT_EXISTS', 'PRE_ENROLLMENT_RUT_EXISTS'].includes(error?.code)) {
      return res.status(409).json({ error: error.message, code: error.code, conflict: error.conflict || null });
    }
    return res.status(error?.status || 500).json({ error: error?.status ? error.message : 'No fue posible crear la pre-matrícula desde esta solicitud.' });
  }
});

module.exports = router;
