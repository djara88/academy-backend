const express = require('express');
const { generateTemporaryPassword } = require('../services/credentialGeneration');
const { emailDeliveryConfigured, accountLinkRedirect, sendAccountLink } = require('../services/accountEmail');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const authIdentityMiddleware = require('../middleware/authIdentity');
const { requireSuperadmin, requireOwnAcademyOrSuperadmin } = require('../middleware/authorization');
const { PLAN_DEFINITIONS, getAcademyEntitlements, resolvePlanCode, getPlanProfessorLimit } = require('../services/planCatalog');
const { BILLING_PLANS, GUARDIAN_ADDON_CLP } = require('../services/billingCatalog');
const { getSubscriptionState } = require('../services/subscriptionAccess');
const { fetchWithTimeout } = require('../services/httpClient');
const { ensureMonthlyChargesForAcademy } = require('../services/monthlyBilling');
const multer = require('multer');

const maxLogoMb = Math.max(1, Number(process.env.MAX_LOGO_MB || 5));
const allowedLogoTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxLogoMb * 1024 * 1024,
    files: 1,
    fields: 20,
    parts: 21,
    fieldNameSize: 100,
    fieldNestingDepth: 2,
  },
  fileFilter: (_req, file, callback) => {
    if (!allowedLogoTypes.has(file.mimetype)) {
      const error = new Error('El logo debe ser JPG, PNG o WEBP.');
      error.code = 'INVALID_LOGO_TYPE';
      return callback(error);
    }
    return callback(null, true);
  },
});
const logoUpload = (req, res, next) => upload.single('logo')(req, res, (error) => {
  if (!error) return next();
  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `El logo no puede superar ${maxLogoMb} MB.` });
  }
  if (error.code === 'INVALID_LOGO_TYPE') {
    return res.status(400).json({ error: error.message });
  }
  return res.status(400).json({ error: 'No fue posible procesar el logo enviado.' });
});

const PLAN_LABELS = {
  formacion: 'Formación',
  competencia: 'Competencia',
  alto_rendimiento: 'Alto Rendimiento',
};
const cleanPlanCode = (value, fallback = 'formacion') => PLAN_DEFINITIONS[value] ? value : fallback;
const trialWindow = () => {
  const start = new Date();
  return { start: start.toISOString(), end: new Date(start.getTime() + 15 * 24 * 60 * 60 * 1000).toISOString() };
};

// Recovery is available to legitimate users without exposing account existence.
// Server-level sensitiveLimiter applies before this route.
router.post('/recuperar-acceso', async (req, res) => {
  const generic = { success: true, message: 'Si el correo está registrado, recibirás un enlace para recuperar tu acceso.' };
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Ingresa un correo electrónico válido.' });
  }
  if (!emailDeliveryConfigured()) {
    return res.status(503).json({ error: 'El servicio de correo está temporalmente no disponible.', code: 'ACCOUNT_EMAIL_NOT_CONFIGURED' });
  }
  try {
    const { data, error } = await supabase.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: { redirectTo: accountLinkRedirect('/cambiar-password') },
    });
    if (error || !data?.properties?.action_link) {
      // Deliberately return an identical response for unknown email addresses.
      return res.status(202).json(generic);
    }
    await sendAccountLink({ to: email, recipientName: '', academyName: 'Lestra Deportivo', link: data.properties.action_link, purpose: 'recover' });
    return res.status(202).json(generic);
  } catch (error) {
    console.error('Falló la entrega del enlace de recuperación:', error?.code || 'RECOVERY_ERROR');
    return res.status(503).json({ error: 'No se pudo iniciar recuperación en este momento. Reintenta más tarde.' });
  }
});

// ====================================================================
// 🚀 NUEVA RUTA: REGISTRO PÚBLICO AUTOMÁTICO (SELF-SERVICE)
// ====================================================================
router.post('/registro-publico', async (req, res) => {
  // Never enroll users without a working verification delivery channel.
  if (!emailDeliveryConfigured()) {
    return res.status(503).json({
      error: 'El registro por correo está temporalmente no disponible. Prueba con Google o inténtalo más tarde.',
      code: 'ACCOUNT_EMAIL_NOT_CONFIGURED',
    });
  }
  const { nombre_academia, nombre_director, email, password } = req.body || {};
  let createdAuthUser = null;
  let createdAcademyId = null;
  try {
    // Supabase creates an unconfirmed user and a single-use signup confirmation link.
    // No service_role-created user may bypass proof of inbox ownership.
    const { data: signup, error: authError } = await supabase.auth.admin.generateLink({
      type: 'signup',
      email: String(email || '').trim().toLowerCase(),
      password,
      options: { redirectTo: accountLinkRedirect('/login') },
    });
    if (authError) {
      if (authError.code === 'user_already_exists' || authError.status === 422) {
        return res.status(409).json({ error: 'Este correo ya está registrado en el sistema.' });
      }
      throw authError;
    }
    createdAuthUser = signup?.user;
    const actionLink = signup?.properties?.action_link;
    if (!createdAuthUser?.id || !actionLink) throw new Error('No se pudo preparar la verificación de correo.');

    const trial = trialWindow();
    const { data: nuevaAcademia, error: dbError } = await supabase
      .from('academias')
      .insert([{
        nombre: nombre_academia,
        nombre_director,
        director_email: String(email || '').trim().toLowerCase(),
        plan: 'Prueba 15 Días', plan_codigo: 'formacion',
        max_profesores: 30, max_jugadores: 1000,
        subscription_status: 'trialing', trial_started_at: trial.start, trial_ends_at: trial.end,
        plan_price_clp: 0, guardian_price_clp: 0,
        estado: 'Activa',
        jugadores_count: 0,
      }])
      .select()
      .single();
    if (dbError) throw dbError;
    createdAcademyId = nuevaAcademia.id;

    const { error: userTableError } = await supabase.from('usuarios').insert([{
      id: createdAuthUser.id,
      academia_id: nuevaAcademia.id,
      nombre_completo: nombre_director,
      rol: 'director',
      requiere_cambio_password: false,
    }]);
    if (userTableError) throw userTableError;

    await sendAccountLink({
      to: String(email || '').trim().toLowerCase(),
      recipientName: nombre_director,
      academyName: nombre_academia,
      link: actionLink,
      purpose: 'verify',
    });
    return res.status(201).json({
      success: true,
      requiresEmailVerification: true,
      message: 'Academia registrada. Revisa tu correo y confirma la dirección antes de iniciar sesión.',
    });
  } catch (error) {
    // Compensate best-effort for failures spanning Auth, PostgreSQL and email.
    // Never leave a confirmed user behind when delivery fails.
    if (createdAuthUser?.id) {
      const { error: authCleanupError } = await supabase.auth.admin.deleteUser(createdAuthUser.id);
      if (authCleanupError) console.error('Error limpiando cuenta de registro incompleto:', authCleanupError.code);
    }
    if (createdAcademyId) {
      const { error: academyCleanupError } = await supabase.from('academias').delete().eq('id', createdAcademyId);
      if (academyCleanupError) console.error('Error limpiando academia de registro incompleto:', academyCleanupError.code);
    }
    console.error('Falló registro con verificación de correo:', error?.code || error?.message || 'UNKNOWN');
    return res.status(503).json({
      error: 'No pudimos completar el registro y enviar el enlace de confirmación. Inténtalo más tarde.',
      code: 'SIGNUP_CONFIRMATION_UNAVAILABLE',
    });
  }
});

// ====================================================================
// 🚀 NUEVA RUTA: COMPLETAR PERFIL CON GOOGLE
// ====================================================================
router.post('/completar-google', authIdentityMiddleware, logoUpload, async (req, res) => {
  try {
    const { nombre_director, nombre_academia, direccion } = req.body;
    const auth_id = req.authUser.id;
    const email = req.authUser.email;
    let logoUrl = null;

    const { data: usuarioExistente, error: existingUserError } = await supabase
      .from('usuarios')
      .select('id')
      .eq('id', auth_id)
      .maybeSingle();
    if (existingUserError) throw existingUserError;
    if (usuarioExistente) {
      return res.status(409).json({ error: 'El usuario ya tiene un perfil configurado.' });
    }

    if (req.file) {
      const fileName = `${Date.now()}_${req.file.originalname.replace(/\s+/g, '_')}`;
      const { error: uploadError } = await supabase.storage
        .from('logos-escuelas')
        .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });

      if (!uploadError) {
        const { data: publicUrlData } = supabase.storage.from('logos-escuelas').getPublicUrl(fileName);
        logoUrl = publicUrlData.publicUrl;
      }
    }

    const trial = trialWindow();
    const { data: nuevaAcademia, error: dbError } = await supabase
      .from('academias')
      .insert([{
        nombre: nombre_academia, direccion, logo: logoUrl,
        nombre_director, director_email: email, plan: 'Prueba 15 Días', plan_codigo: 'formacion',
        max_profesores: 30, max_jugadores: 1000,
        subscription_status: 'trialing', trial_started_at: trial.start, trial_ends_at: trial.end,
        plan_price_clp: 0, guardian_price_clp: 0,
        estado: 'Activa', jugadores_count: 0
      }])
      .select()
      .single();

    if (dbError) throw dbError;

    const { error: userTableError } = await supabase.from('usuarios').insert([{
      id: auth_id, academia_id: nuevaAcademia.id,
      nombre_completo: nombre_director, rol: 'director', requiere_cambio_password: false
    }]);

    if (userTableError) throw userTableError;

    res.status(200).json({ success: true, academia: nuevaAcademia });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Error al completar el perfil' });
  }
});

// ====================================================================
// 🏟️ RUTAS DE CONFIGURACIÓN DE MI ACADEMIA (DÍAS, HORARIOS Y LUGAR)
// ====================================================================
router.get('/mi-academia', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const { data, error } = await supabase
      .from('academias')
      .select('*')
      .eq('id', academia_id)
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/mi-plan', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('academias')
      .select('id,nombre,plan,plan_codigo,max_profesores,max_jugadores,licencia_apoderados,estado,subscription_status,trial_started_at,trial_ends_at,blocked_at,blocked_reason,next_billing_date,plan_price_clp,guardian_price_clp')
      .eq('id', req.user.academia_id).single();
    if (error) throw error;
    res.json({ success: true, data: { ...getAcademyEntitlements(data), subscription: getSubscriptionState(data) } });
  } catch (error) {
    res.status(500).json({ error: 'No fue posible consultar el plan de tu academia.' });
  }
});

router.put('/mi-academia', authMiddleware, async (req, res) => {
  try {
    const { academia_id } = req.user;
    const {
      nombre, dias_entrenamiento, horarios_entrenamiento, ubicacion_entrenamiento,
      dia_vencimiento_mensualidad, dias_aviso_mensualidad,
    } = req.body;

    const dueDay = dia_vencimiento_mensualidad === '' || dia_vencimiento_mensualidad === null || dia_vencimiento_mensualidad === undefined
      ? null
      : Number(dia_vencimiento_mensualidad);
    const warningDays = dias_aviso_mensualidad === '' || dias_aviso_mensualidad === null || dias_aviso_mensualidad === undefined
      ? 3
      : Number(dias_aviso_mensualidad);
    if (dueDay !== null && (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31)) {
      return res.status(400).json({ error: 'El día de pago mensual debe estar entre 1 y 31.' });
    }
    if (!Number.isInteger(warningDays) || warningDays < 0 || warningDays > 15) {
      return res.status(400).json({ error: 'Los días de aviso deben estar entre 0 y 15.' });
    }

    const { data, error } = await supabase
      .from('academias')
      .update({
        nombre,
        dias_entrenamiento,
        horarios_entrenamiento,
        ubicacion_entrenamiento,
        dia_vencimiento_mensualidad: dueDay,
        dias_aviso_mensualidad: warningDays,
      })
      .eq('id', academia_id)
      .select()
      .single();

    if (error) throw error;
    const billing = await ensureMonthlyChargesForAcademy(academia_id);
    res.json({ success: true, data, billing });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ====================================================================
// RUTAS DE ADMINISTRACIÓN
// ====================================================================

router.get('/', authMiddleware, requireSuperadmin, async (req, res) => {
  const { data, error } = await supabase.from('academias').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Error de Supabase' });
  res.json(data || []);
});

router.post('/', authMiddleware, requireSuperadmin, logoUpload, async (req, res) => {
  const { nombre, direccion, telefono, correo_academia, nombre_director, director_email } = req.body;
  let createdAuthUser = null;

  try {
    const tempPassword = generateTemporaryPassword();

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: director_email, password: tempPassword, email_confirm: true
    });

    if (authError) throw authError;
    createdAuthUser = authData.user;

    let logoUrl = null;
    if (req.file) {
      const fileName = `${Date.now()}_${req.file.originalname.replace(/\s+/g, '_')}`;
      await supabase.storage.from('logos-escuelas').upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
      const { data: publicUrlData } = supabase.storage.from('logos-escuelas').getPublicUrl(fileName);
      logoUrl = publicUrlData.publicUrl;
    }

    const planCode = cleanPlanCode(req.body.plan_codigo || resolvePlanCode({ plan: req.body.plan }));
    const billingPlan = BILLING_PLANS[planCode];
    const guardianLicense = req.body.licencia_apoderados === 'true' || req.body.licencia_apoderados === true;
    const { data: nuevaAcademia, error: dbError } = await supabase
      .from('academias')
      .insert([{
        nombre, logo: logoUrl, direccion, telefono, correo_academia, nombre_director, director_email,
        plan: PLAN_LABELS[planCode], plan_codigo: planCode,
        max_profesores: getPlanProfessorLimit(planCode), max_jugadores: billingPlan.playerLimit || 100000,
        licencia_apoderados: guardianLicense,
        subscription_status: 'active', plan_price_clp: billingPlan.priceClp,
        guardian_price_clp: guardianLicense ? GUARDIAN_ADDON_CLP : 0,
        next_billing_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        estado: 'Activa', jugadores_count: 0,
      }])
      .select().single();

    if (dbError) throw dbError;

    await supabase.from('usuarios').insert([{
      id: createdAuthUser.id, academia_id: nuevaAcademia.id, nombre_completo: nombre_director,
      rol: 'director', requiere_cambio_password: true
    }]);

    res.status(201).json(nuevaAcademia);
  } catch (error) {
    if (createdAuthUser) await supabase.auth.admin.deleteUser(createdAuthUser.id);
    res.status(500).json({ error: error.message || 'Error interno del servidor' });
  }
});

router.put('/:id', authMiddleware, requireSuperadmin, logoUpload, async (req, res) => {
  const { id } = req.params;
  const { nombre, direccion, telefono, correo_academia, nombre_director, director_email, estado } = req.body;

  try {
    const { data: current, error: currentError } = await supabase.from('academias')
      .select('plan,plan_codigo,subscription_status').eq('id', id).single();
    if (currentError) throw currentError;
    const planCode = cleanPlanCode(req.body.plan_codigo || resolvePlanCode({ plan: req.body.plan }), current.plan_codigo || 'formacion');
    const billingPlan = BILLING_PLANS[planCode];
    const guardianLicense = req.body.licencia_apoderados === 'true' || req.body.licencia_apoderados === true;
    const activateSubscription = req.body.activate_subscription === 'true';
    let updateData = { nombre, direccion, telefono, correo_academia, nombre_director, director_email, estado };
    // Una edición de datos institucionales nunca debe convertir silenciosamente
    // una prueba Full en un plan pagado. La activación requiere una acción explícita.
    if (activateSubscription || current.subscription_status !== 'trialing') {
      Object.assign(updateData, {
        plan: PLAN_LABELS[planCode],
        plan_codigo: planCode,
        max_profesores: getPlanProfessorLimit(planCode), max_jugadores: billingPlan.playerLimit || 100000,
        licencia_apoderados: guardianLicense,
        plan_price_clp: billingPlan.priceClp,
        guardian_price_clp: guardianLicense ? GUARDIAN_ADDON_CLP : 0,
      });
      updateData.subscription_status = req.body.subscription_status || 'active';
      updateData.blocked_at = null;
      updateData.blocked_reason = null;
      updateData.estado = estado === 'Inactiva' ? 'Inactiva' : 'Activa';
      updateData.next_billing_date = req.body.next_billing_date || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    }
    if (req.file) {
      const fileName = `${Date.now()}_${req.file.originalname.replace(/\s+/g, '_')}`;
      await supabase.storage.from('logos-escuelas').upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
      updateData.logo = supabase.storage.from('logos-escuelas').getPublicUrl(fileName).data.publicUrl;
    }
    const { data, error } = await supabase.from('academias').update(updateData).eq('id', id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', authMiddleware, requireSuperadmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabase.from('academias').delete().eq('id', id);
    if (error) throw error;
    res.json({ message: 'Academia eliminada exitosamente' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/reset-password', authMiddleware, requireSuperadmin, async (req, res) => {
  if (!emailDeliveryConfigured()) {
    return res.status(503).json({ error: 'El servicio de recuperación por correo no está disponible.', code: 'ACCOUNT_EMAIL_NOT_CONFIGURED' });
  }
  try {
    const { id } = req.params;
    const { data: academy, error: academyError } = await supabase.from('academias')
      .select('id,nombre,director_email,nombre_director').eq('id', id).single();
    if (academyError || !academy?.director_email) {
      return res.status(404).json({ error: 'Academia o correo de director no encontrado.' });
    }
    const { data: director, error: directorError } = await supabase.from('usuarios')
      .select('id').eq('academia_id', id).eq('rol', 'director').limit(1).maybeSingle();
    if (directorError) throw directorError;
    if (!director?.id) return res.status(409).json({ error: 'La academia no tiene un director con acceso válido.' });

    // Prevent sending an account-recovery link to a stale/mismatched director address.
    const { data: authRecord, error: userError } = await supabase.auth.admin.getUserById(director.id);
    if (userError) throw userError;
    const normalizedEmail = String(academy.director_email).trim().toLowerCase();
    if (!authRecord?.user?.email || authRecord.user.email.toLowerCase() !== normalizedEmail) {
      return res.status(409).json({ error: 'El correo del director no coincide con la identidad autenticada. Actualízalo antes de recuperar la cuenta.' });
    }

    // Generate an expiring, one-use recovery link; do not overwrite the password.
    const { data: recovery, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'recovery',
      email: normalizedEmail,
      options: { redirectTo: accountLinkRedirect('/cambiar-password') },
    });
    if (linkError || !recovery?.properties?.action_link) throw linkError || new Error('Recovery link unavailable');

    await sendAccountLink({
      to: normalizedEmail,
      recipientName: academy.nombre_director,
      academyName: academy.nombre,
      link: recovery.properties.action_link,
      purpose: 'recover',
    });
    return res.status(202).json({ success: true, message: 'Enlace de recuperación enviado al correo del director.' });
  } catch (error) {
    console.error('No fue posible iniciar recuperación administrativa:', error?.code || error?.message || 'UNKNOWN');
    return res.status(503).json({ error: 'No se pudo entregar el enlace de recuperación. Reintenta más tarde.', code: 'RECOVERY_EMAIL_UNAVAILABLE' });
  }
});

// ====================================================================
// RUTAS DE TÉRMINOS Y CONDICIONES
// ====================================================================

// Obtener datos y términos de una academia específica
router.get('/:id', authMiddleware, requireOwnAcademyOrSuperadmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase.from('academias').select('*').eq('id', id).single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener datos de la academia' });
  }
});

// Actualizar los términos de una academia
router.put('/:id/terminos', authMiddleware, requireOwnAcademyOrSuperadmin, async (req, res) => {
  const { id } = req.params;
  const { terminos_condiciones } = req.body;

  try {
    const { data, error } = await supabase
      .from('academias')
      .update({ terminos_condiciones })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar términos' });
  }
});

module.exports = router;
