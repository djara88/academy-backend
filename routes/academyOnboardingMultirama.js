const express = require('express');
const multer = require('multer');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const authIdentityMiddleware = require('../middleware/authIdentity');
const { requireDirector } = require('../middleware/professorAccess');
const { validatePassword } = require('../services/passwordPolicy');
const { fetchWithTimeout } = require('../services/httpClient');
const {
  ALLOWED_DISCIPLINES,
  createInitialStructure,
  setPrimaryBranch,
} = require('../services/academyStructureService');
const { listAcademyBranches } = require('../services/branchContext');

const router = express.Router();
const maxLogoMb = Math.max(1, Number(process.env.MAX_LOGO_MB || 5));
const allowedLogoTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxLogoMb * 1024 * 1024, files: 1, fields: 24, parts: 25 },
  fileFilter: (_req, file, callback) => {
    if (!allowedLogoTypes.has(file.mimetype)) return callback(Object.assign(new Error('El logo debe ser JPG, PNG o WEBP.'), { code: 'INVALID_LOGO_TYPE' }));
    return callback(null, true);
  },
});

const logoUpload = (req, res, next) => upload.single('logo')(req, res, (error) => {
  if (!error) return next();
  if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `El logo no puede superar ${maxLogoMb} MB.` });
  return res.status(400).json({ error: error.message || 'No fue posible procesar el logo.' });
});

const trialWindow = () => {
  const start = new Date();
  return { start: start.toISOString(), end: new Date(start.getTime() + 15 * 24 * 60 * 60 * 1000).toISOString() };
};

const safeText = (value, max = 180) => String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);

const sendWelcomeEmail = async ({ email, directorName, academyName }) => {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!apiKey || !senderEmail || !email) return false;
  try {
    const response = await fetchWithTimeout('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { accept: 'application/json', 'api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'Syncademia', email: senderEmail },
        to: [{ email }],
        subject: '¡Bienvenido a Syncademia! 🚀',
        htmlContent: `<div style="font-family:sans-serif;color:#333"><h2>¡Hola ${directorName}! Bienvenido a Syncademia</h2><p>Tu academia <strong>${academyName}</strong> fue creada con éxito y ya tiene configurada su primera sede y rama deportiva.</p><p>Tienes 15 días de prueba para conocer la plataforma completa.</p><p>El equipo de Syncademia</p></div>`,
      }),
    }, 10000);
    return response.ok;
  } catch (error) {
    console.warn('No fue posible enviar correo de bienvenida:', error?.message || error);
    return false;
  }
};

const createTrialAcademy = async ({ academyName, directorName, email, address = null }) => {
  const trial = trialWindow();
  const { data, error } = await supabase.from('academias').insert({
    nombre: academyName,
    direccion: address || null,
    nombre_director: directorName,
    director_email: email,
    plan: 'Prueba 15 Días',
    plan_codigo: 'formacion',
    max_profesores: 30,
    max_jugadores: 1000,
    subscription_status: 'trialing',
    trial_started_at: trial.start,
    trial_ends_at: trial.end,
    plan_price_clp: 0,
    guardian_price_clp: 0,
    estado: 'Activa',
    jugadores_count: 0,
  }).select('*').single();
  if (error) throw error;
  return data;
};

router.get('/disciplinas', (_req, res) => {
  res.json({ success: true, data: ALLOWED_DISCIPLINES });
});

router.post('/registro-publico', async (req, res) => {
  const academyName = safeText(req.body?.nombre_academia);
  const directorName = safeText(req.body?.nombre_director);
  const email = safeText(req.body?.email, 254).toLowerCase();
  const password = String(req.body?.password || '');
  const discipline = safeText(req.body?.disciplina_principal, 80);
  const branchName = safeText(req.body?.nombre_rama_principal || discipline, 180);
  const siteName = safeText(req.body?.nombre_sede_principal || 'Sede Principal', 180);
  const address = safeText(req.body?.direccion, 300) || null;
  let authUser = null;
  let academy = null;

  try {
    if (!academyName || !directorName || !email || !discipline) {
      return res.status(400).json({ error: 'Academia, director, correo y disciplina principal son obligatorios.' });
    }
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) return res.status(400).json({ error: passwordValidation.message, code: 'WEAK_PASSWORD' });

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (authError) {
      if (authError.code === 'user_already_exists' || authError.status === 422) return res.status(409).json({ error: 'Este correo ya está registrado en el sistema.' });
      throw authError;
    }
    authUser = authData.user;
    academy = await createTrialAcademy({ academyName, directorName, email, address });

    const { error: userError } = await supabase.from('usuarios').insert({
      id: authUser.id,
      academia_id: academy.id,
      nombre_completo: directorName,
      nombre: directorName,
      email,
      correo: email,
      rol: 'director',
      activo: true,
      requiere_cambio_password: false,
    });
    if (userError) throw userError;

    const structure = await createInitialStructure({
      academyId: academy.id,
      discipline,
      branchName,
      siteName,
      address,
    });
    await sendWelcomeEmail({ email, directorName, academyName });

    return res.status(201).json({ success: true, academia: { ...academy, rama_principal_id: structure.branch.id }, estructura: structure });
  } catch (error) {
    if (academy?.id) {
      await supabase.from('usuarios').delete().eq('academia_id', academy.id);
      await supabase.from('ramas').delete().eq('academia_id', academy.id);
      await supabase.from('sedes').delete().eq('academia_id', academy.id);
      await supabase.from('academias').delete().eq('id', academy.id);
    }
    if (authUser?.id) await supabase.auth.admin.deleteUser(authUser.id);
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible crear la academia.', code: error?.code });
  }
});

router.post('/completar-google', authIdentityMiddleware, logoUpload, async (req, res) => {
  const directorName = safeText(req.body?.nombre_director || req.authUser?.user_metadata?.full_name || 'Director');
  const academyName = safeText(req.body?.nombre_academia);
  const address = safeText(req.body?.direccion, 300) || null;
  const discipline = safeText(req.body?.disciplina_principal, 80);
  const branchName = safeText(req.body?.nombre_rama_principal || discipline, 180);
  const siteName = safeText(req.body?.nombre_sede_principal || 'Sede Principal', 180);
  const authId = req.authUser.id;
  const email = req.authUser.email;
  let academy = null;
  let logoUrl = null;
  let uploadedLogoPath = null;

  try {
    if (!academyName || !discipline) return res.status(400).json({ error: 'Nombre de academia y disciplina principal son obligatorios.' });
    const { data: existing, error: existingError } = await supabase.from('usuarios').select('id').eq('id', authId).maybeSingle();
    if (existingError) throw existingError;
    if (existing) return res.status(409).json({ error: 'El usuario ya tiene un perfil configurado.' });

    if (req.file) {
      uploadedLogoPath = `${Date.now()}_${req.file.originalname.replace(/\s+/g, '_')}`;
      const { error: uploadError } = await supabase.storage.from('logos-escuelas')
        .upload(uploadedLogoPath, req.file.buffer, { contentType: req.file.mimetype });
      if (uploadError) throw uploadError;
      logoUrl = supabase.storage.from('logos-escuelas').getPublicUrl(uploadedLogoPath).data.publicUrl;
    }

    academy = await createTrialAcademy({ academyName, directorName, email, address });
    if (logoUrl) {
      const { error: logoError } = await supabase.from('academias').update({ logo: logoUrl, logo_url: logoUrl }).eq('id', academy.id);
      if (logoError) throw logoError;
    }

    const { error: userError } = await supabase.from('usuarios').insert({
      id: authId,
      academia_id: academy.id,
      nombre_completo: directorName,
      nombre: directorName,
      email,
      correo: email,
      rol: 'director',
      activo: true,
      requiere_cambio_password: false,
    });
    if (userError) throw userError;

    const structure = await createInitialStructure({ academyId: academy.id, discipline, branchName, siteName, address });
    return res.status(200).json({ success: true, academia: { ...academy, logo: logoUrl, logo_url: logoUrl, rama_principal_id: structure.branch.id }, estructura: structure });
  } catch (error) {
    if (academy?.id) {
      await supabase.from('usuarios').delete().eq('academia_id', academy.id);
      await supabase.from('ramas').delete().eq('academia_id', academy.id);
      await supabase.from('sedes').delete().eq('academia_id', academy.id);
      await supabase.from('academias').delete().eq('id', academy.id);
    }
    if (uploadedLogoPath) await supabase.storage.from('logos-escuelas').remove([uploadedLogoPath]);
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible completar la configuración.', code: error?.code });
  }
});

router.get('/rama-principal', authMiddleware, requireDirector, async (req, res) => {
  try {
    const [{ data: academy, error: academyError }, branches] = await Promise.all([
      supabase.from('academias').select('id,rama_principal_id').eq('id', req.user.academia_id).single(),
      listAcademyBranches(req.user.academia_id),
    ]);
    if (academyError) throw academyError;
    return res.json({ success: true, data: { rama_principal_id: academy.rama_principal_id || null, ramas: branches } });
  } catch (error) {
    return res.status(500).json({ error: 'No fue posible cargar la rama principal.' });
  }
});

router.put('/rama-principal', authMiddleware, requireDirector, async (req, res) => {
  try {
    const branchId = safeText(req.body?.rama_id, 80);
    if (!branchId) return res.status(400).json({ error: 'Selecciona la rama principal.' });
    const data = await setPrimaryBranch(req.user.academia_id, branchId);
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible cambiar la rama principal.', code: error?.code });
  }
});

module.exports = router;
