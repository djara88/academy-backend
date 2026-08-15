const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const authIdentityMiddleware = require('../middleware/authIdentity');
const { requireSuperadmin, requireOwnAcademyOrSuperadmin } = require('../middleware/authorization');
const { PLAN_DEFINITIONS, getAcademyEntitlements, resolvePlanCode, getPlanProfessorLimit } = require('../services/planCatalog');
const { BILLING_PLANS, GUARDIAN_ADDON_CLP } = require('../services/billingCatalog');
const { getSubscriptionState } = require('../services/subscriptionAccess');
const { fetchWithTimeout } = require('../services/httpClient');
const multer = require('multer');

const maxLogoMb = Math.max(1, Number(process.env.MAX_LOGO_MB || 5));
const allowedLogoTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxLogoMb * 1024 * 1024, files: 1 },
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

// ====================================================================
// 🚀 NUEVA RUTA: REGISTRO PÚBLICO AUTOMÁTICO (SELF-SERVICE)
// ====================================================================
router.post('/registro-publico', async (req, res) => {
  const { nombre_academia, nombre_director, email, password } = req.body;
  let createdAuthUser = null;

  try {
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true
    });

    if (authError) {
      if (authError.code === 'user_already_exists' || authError.status === 422) {
        return res.status(400).json({ error: 'Este correo ya está registrado en el sistema.' });
      }
      throw authError;
    }

    createdAuthUser = authData.user;

    const trial = trialWindow();
    const { data: nuevaAcademia, error: dbError } = await supabase
      .from('academias')
      .insert([{
        nombre: nombre_academia,
        nombre_director: nombre_director,
        director_email: email,
        plan: 'Prueba 15 Días', plan_codigo: 'formacion',
        max_profesores: 30, max_jugadores: 1000,
        subscription_status: 'trialing', trial_started_at: trial.start, trial_ends_at: trial.end,
        plan_price_clp: 0, guardian_price_clp: 0,
        estado: 'Activa',
        jugadores_count: 0
      }])
      .select()
      .single();

    if (dbError) throw dbError;

    const { error: userTableError } = await supabase.from('usuarios').insert([{
      id: createdAuthUser.id,
      academia_id: nuevaAcademia.id,
      nombre_completo: nombre_director,
      rol: 'director',
      requiere_cambio_password: false
    }]);

    if (userTableError) throw userTableError;

    const brevoApiKey = process.env.BREVO_API_KEY;
    const brevoSenderEmail = process.env.BREVO_SENDER_EMAIL;

    if (brevoApiKey && brevoSenderEmail) {
      try {
        await fetchWithTimeout('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'accept': 'application/json',
            'api-key': brevoApiKey,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            sender: { name: "Syncademia", email: brevoSenderEmail },
            to: [{ email: email }],
            subject: "¡Bienvenido a Syncademia! 🚀",
            htmlContent: `
              <div style="font-family: sans-serif; color: #333;">
                <h2>¡Hola ${nombre_director}! Bienvenido a Syncademia</h2>
                <p>Tu academia <strong>${nombre_academia}</strong> ha sido creada con éxito.</p>
                <p>Tienes 15 días de prueba gratis para disfrutar de todas las funcionalidades.</p>
                <p>Ya puedes iniciar sesión utilizando tu correo y la contraseña que creaste.</p>
                <p>¡Mucho éxito en tu gestión!</p>
                <p>El equipo de Syncademia</p>
                <p><em>Gestión de academias deportivas, tu ecosistema de élite.</em></p>
              </div>
            `
          })
        }, 10000);
      } catch (fetchError) {
        console.error(`❌ Error al enviar correo de bienvenida:`, fetchError);
      }
    }

    res.status(201).json({ success: true, academia: nuevaAcademia });
  } catch (error) {
    if (createdAuthUser) await supabase.auth.admin.deleteUser(createdAuthUser.id);
    res.status(500).json({ error: error.message || 'Error interno del servidor al crear tu cuenta' });
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
    const { nombre, dias_entrenamiento, horarios_entrenamiento, ubicacion_entrenamiento } = req.body;

    const { data, error } = await supabase
      .from('academias')
      .update({
        nombre,
        dias_entrenamiento,
        horarios_entrenamiento,
        ubicacion_entrenamiento
      })
      .eq('id', academia_id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
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
    const tempPassword = Math.random().toString(36).substring(2, 10) + "A1!";

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
  const { id } = req.params;
  try {
    const { data: academia, error: acaError } = await supabase.from('academias').select('director_email, nombre_director').eq('id', id).single();
    if (acaError) throw new Error('Academia no encontrada');

    const newPassword = Math.random().toString(36).substring(2, 10) + "X9#";
    const { data: userData } = await supabase.from('usuarios').select('id').eq('academia_id', id).single();

    if (userData && userData.id) {
      await supabase.auth.admin.updateUserById(userData.id, { password: newPassword });
      await supabase.from('usuarios').update({ requiere_cambio_password: true }).eq('id', userData.id);
    }
    res.json({ message: 'Contraseña restablecida' });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
