const express = require('express');
const multer = require('multer');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const authIdentityMiddleware = require('../middleware/authIdentity');
const { requireDirector } = require('../middleware/professorAccess');
const { validatePassword } = require('../services/passwordPolicy');
const { fetchWithTimeout } = require('../services/httpClient');
const { getAcademyEntitlements, FEATURES } = require('../services/planCatalog');
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
const publicBaseUrl = () => String(process.env.FRONTEND_URL || 'https://lestra.app').replace(/\/$/, '');
const normalizeSlug = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

const loadAcademyPlan = async (academyId) => {
  const { data, error } = await supabase.from('academias')
    .select('id,nombre,plan,plan_codigo,max_profesores,licencia_apoderados,guardian_license_ends_at,trial_ends_at,subscription_status,rama_principal_id,subdominio,pagina_publica_activa,descripcion_publica')
    .eq('id', academyId).single();
  if (error || !data) throw error || new Error('Academia no encontrada.');
  return { academy: data, entitlements: getAcademyEntitlements(data) };
};

const assertFriendlies = async (academyId) => {
  const context = await loadAcademyPlan(academyId);
  if (!context.entitlements.features.includes(FEATURES.FRIENDLIES)) {
    const error = new Error('Los amistosos no están habilitados en tu plan.');
    error.status = 403;
    error.code = 'FEATURE_NOT_INCLUDED';
    throw error;
  }
  return context;
};

const getOperationalPlanSnapshot = async (academyId) => {
  const { academy, entitlements } = await loadAcademyPlan(academyId);
  const [players, professors, sites, branches, categories, finance, attendance] = await Promise.all([
    supabase.from('jugadores').select('id', { count: 'exact', head: true }).eq('academia_id', academyId),
    supabase.from('usuarios').select('id', { count: 'exact', head: true }).eq('academia_id', academyId).eq('rol', 'profesor').eq('activo', true),
    supabase.from('sedes').select('id,nombre,principal,activa,bloqueada_por_plan', { count: 'exact' }).eq('academia_id', academyId).order('principal', { ascending: false }).order('created_at'),
    supabase.from('ramas').select('id,nombre,disciplina,sede_id,principal,activa,bloqueada_por_plan,sedes(id,nombre)', { count: 'exact' }).eq('academia_id', academyId).order('principal', { ascending: false }).order('created_at'),
    supabase.from('categorias').select('id', { count: 'exact', head: true }).eq('academia_id', academyId),
    supabase.from('configuracion_financiera').select('academia_id').eq('academia_id', academyId).maybeSingle(),
    supabase.from('asistencias').select('id', { count: 'exact', head: true }).in('entrenamiento_id', (await supabase.from('entrenamientos').select('id').eq('academia_id', academyId).limit(5000)).data?.map((item) => item.id) || []),
  ]);
  for (const result of [players, professors, sites, branches, categories, finance]) if (result.error) throw result.error;
  const activeSites = (sites.data || []).filter((item) => item.activa !== false);
  const activeBranches = (branches.data || []).filter((item) => item.activa !== false);
  const siteLimit = entitlements.limits.sites;
  const branchLimit = entitlements.limits.branches;
  const structureOverLimit = (Number.isInteger(siteLimit) && activeSites.length > siteLimit)
    || (Number.isInteger(branchLimit) && activeBranches.length > branchLimit);
  return {
    academy,
    entitlements,
    usage: {
      players: { used: Number(players.count || 0), limit: entitlements.limits.players },
      professors: { used: Number(professors.count || 0), limit: entitlements.limits.professors },
      sites: { used: activeSites.length, limit: siteLimit },
      branches: { used: activeBranches.length, limit: branchLimit },
    },
    structure: {
      requiresChoice: Boolean(structureOverLimit || (Number.isInteger(branchLimit) && branchLimit === 1 && !academy.rama_principal_id)),
      primaryBranchId: academy.rama_principal_id || null,
      sites: sites.data || [],
      branches: branches.data || [],
    },
    onboarding: [
      { key: 'estructura', label: 'Definir sede y rama principal', done: Boolean(academy.rama_principal_id) },
      { key: 'categorias', label: 'Crear categorías', done: Number(categories.count || 0) > 0 },
      { key: 'profesores', label: 'Agregar al menos un profesor', done: Number(professors.count || 0) > 0 },
      { key: 'alumnos', label: 'Registrar o importar alumnos', done: Number(players.count || 0) > 0 },
      { key: 'finanzas', label: 'Configurar recaudación', done: Boolean(finance.data) },
      { key: 'asistencia', label: 'Registrar la primera asistencia', done: Number(attendance.count || 0) > 0 },
      { key: 'pagina_publica', label: 'Revisar la página pública de inscripción', done: Boolean(academy.subdominio && academy.pagina_publica_activa) },
    ],
  };
};

const sendWelcomeEmail = async ({ email, directorName, academyName }) => {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!apiKey || !senderEmail || !email) return false;
  try {
    const response = await fetchWithTimeout('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { accept: 'application/json', 'api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'Lestra', email: senderEmail },
        to: [{ email }],
        subject: '¡Bienvenido a Lestra! 🚀',
        htmlContent: `<div style="font-family:sans-serif;color:#333"><h2>¡Hola ${directorName}! Bienvenido a Lestra</h2><p>Tu academia <strong>${academyName}</strong> fue creada con éxito y ya tiene configurada su primera sede y rama deportiva.</p><p>Tienes 15 días de prueba Full para conocer la plataforma completa.</p><p>El equipo de Lestra</p></div>`,
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
    correo_academia: email,
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
    pagina_publica_activa: true,
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

    const structure = await createInitialStructure({ academyId: academy.id, discipline, branchName, siteName, address });
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
      const { error: uploadError } = await supabase.storage.from('logos-escuelas').upload(uploadedLogoPath, req.file.buffer, { contentType: req.file.mimetype });
      if (uploadError) throw uploadError;
      logoUrl = supabase.storage.from('logos-escuelas').getPublicUrl(uploadedLogoPath).data.publicUrl;
    }

    academy = await createTrialAcademy({ academyName, directorName, email, address });
    if (logoUrl) {
      const { error: logoError } = await supabase.from('academias').update({ logo: logoUrl, logo_url: logoUrl }).eq('id', academy.id);
      if (logoError) throw logoError;
    }

    const { error: userError } = await supabase.from('usuarios').insert({
      id: authId, academia_id: academy.id,
      nombre_completo: directorName, nombre: directorName, email, correo: email,
      rol: 'director', activo: true, requiere_cambio_password: false,
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
  } catch (_error) {
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

router.get('/plan-operativo', authMiddleware, requireDirector, async (req, res) => {
  try {
    const data = await getOperationalPlanSnapshot(req.user.academia_id);
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error cargando plan operativo:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible revisar el uso de tu plan.' });
  }
});

router.get('/pagina-publica', authMiddleware, requireDirector, async (req, res) => {
  try {
    const { data, error } = await supabase.from('academias')
      .select('id,nombre,subdominio,pagina_publica_activa,descripcion_publica,logo,logo_url,direccion,telefono,correo_academia')
      .eq('id', req.user.academia_id).single();
    if (error) throw error;
    return res.json({ success: true, data: { ...data, url: `${publicBaseUrl()}/a/${data.subdominio}` } });
  } catch (_error) {
    return res.status(500).json({ error: 'No fue posible cargar la página pública.' });
  }
});

router.put('/pagina-publica', authMiddleware, requireDirector, async (req, res) => {
  try {
    const changes = {
      pagina_publica_activa: req.body?.activa !== false,
      descripcion_publica: safeText(req.body?.descripcion, 1200) || null,
    };
    if (req.body?.slug !== undefined) {
      const slug = normalizeSlug(req.body.slug);
      if (slug.length < 3) return res.status(400).json({ error: 'El enlace público debe tener al menos 3 caracteres.' });
      changes.subdominio = slug;
    }
    const { data, error } = await supabase.from('academias').update(changes)
      .eq('id', req.user.academia_id)
      .select('id,nombre,subdominio,pagina_publica_activa,descripcion_publica').single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Ese enlace público ya está siendo utilizado.' });
      throw error;
    }
    return res.json({ success: true, data: { ...data, url: `${publicBaseUrl()}/a/${data.subdominio}` } });
  } catch (_error) {
    return res.status(500).json({ error: 'No fue posible actualizar la página pública.' });
  }
});

router.get('/amistosos', authMiddleware, requireDirector, async (req, res) => {
  try {
    await assertFriendlies(req.user.academia_id);
    const [eventsResult, tournamentsResult, branches, categoriesResult] = await Promise.all([
      supabase.from('partidos')
        .select('id,torneo_id,rival,fecha,hora,hora_citacion,ubicacion,condicion,estado,categoria_id,rama_id,sede_id,es_amistoso,categorias(id,nombre),ramas(id,nombre,disciplina),sedes(id,nombre),torneos(id,nombre)')
        .eq('academia_id', req.user.academia_id).eq('es_amistoso', true)
        .order('fecha', { ascending: true }).order('hora', { ascending: true }),
      supabase.from('torneos')
        .select('id,nombre,fecha_inicio,fecha_fin,organizador,ubicacion,estado,rama_id,sede_id,config_competencia,ramas(id,nombre,disciplina),sedes(id,nombre)')
        .eq('academia_id', req.user.academia_id).contains('config_competencia', { amistoso: true })
        .order('fecha_inicio', { ascending: true }),
      listAcademyBranches(req.user.academia_id),
      supabase.from('categorias').select('id,nombre,rama_id,sede_id').eq('academia_id', req.user.academia_id).order('nombre'),
    ]);
    if (eventsResult.error) throw eventsResult.error;
    if (tournamentsResult.error) throw tournamentsResult.error;
    if (categoriesResult.error) throw categoriesResult.error;
    return res.json({ success: true, data: {
      eventos: eventsResult.data || [],
      competencias: tournamentsResult.data || [],
      ramas: branches,
      categorias: categoriesResult.data || [],
    } });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible cargar los amistosos.', code: error?.code });
  }
});

router.post('/amistosos/competencias', authMiddleware, requireDirector, async (req, res) => {
  try {
    await assertFriendlies(req.user.academia_id);
    const branchId = safeText(req.body?.rama_id, 80);
    const name = safeText(req.body?.nombre, 180);
    if (!branchId || !name) return res.status(400).json({ error: 'Selecciona una rama e ingresa el nombre de la competencia amistosa.' });
    const { data: branch, error: branchError } = await supabase.from('ramas').select('id,sede_id,activa').eq('id', branchId).eq('academia_id', req.user.academia_id).maybeSingle();
    if (branchError) throw branchError;
    if (!branch || branch.activa === false) return res.status(409).json({ error: 'La rama seleccionada no está activa en tu plan.' });
    const { data, error } = await supabase.from('torneos').insert({
      academia_id: req.user.academia_id,
      sede_id: branch.sede_id,
      rama_id: branch.id,
      nombre: name,
      fecha_inicio: req.body?.fecha_inicio || null,
      fecha_fin: req.body?.fecha_fin || req.body?.fecha_inicio || null,
      tipo_gestion: 'externo',
      formato_competencia: 'seguimiento',
      organizador: safeText(req.body?.organizador, 180) || null,
      ubicacion: safeText(req.body?.ubicacion, 300) || null,
      config_competencia: { amistoso: true, formation_preview: true },
      estructura_estado: 'no_aplica',
      costo_inscripcion: 0,
      permite_cuotas: false,
      max_cuotas: 1,
      estado: 'Activo',
    }).select('id,nombre,fecha_inicio,fecha_fin,organizador,ubicacion,estado,rama_id,sede_id').single();
    if (error) throw error;
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible crear la competencia amistosa.' });
  }
});

router.post('/amistosos/eventos', authMiddleware, requireDirector, async (req, res) => {
  try {
    await assertFriendlies(req.user.academia_id);
    const branchId = safeText(req.body?.rama_id, 80);
    const categoryId = safeText(req.body?.categoria_id, 80);
    const reference = safeText(req.body?.rival, 180);
    if (!branchId || !categoryId || !reference || !req.body?.fecha || !req.body?.hora) {
      return res.status(400).json({ error: 'Rama, categoría, rival/prueba, fecha y hora son obligatorios.' });
    }
    const [{ data: branch, error: branchError }, { data: category, error: categoryError }] = await Promise.all([
      supabase.from('ramas').select('id,sede_id,disciplina,activa').eq('id', branchId).eq('academia_id', req.user.academia_id).maybeSingle(),
      supabase.from('categorias').select('id,rama_id,sede_id').eq('id', categoryId).eq('academia_id', req.user.academia_id).maybeSingle(),
    ]);
    if (branchError) throw branchError;
    if (categoryError) throw categoryError;
    if (!branch || branch.activa === false) return res.status(409).json({ error: 'La rama seleccionada no está activa en tu plan.' });
    if (!category || String(category.rama_id) !== String(branch.id)) return res.status(409).json({ error: 'La categoría no pertenece a la rama seleccionada.' });

    let tournamentId = safeText(req.body?.torneo_id, 80) || null;
    if (tournamentId) {
      const { data: tournament, error: tournamentError } = await supabase.from('torneos')
        .select('id,rama_id,config_competencia').eq('id', tournamentId).eq('academia_id', req.user.academia_id).maybeSingle();
      if (tournamentError) throw tournamentError;
      if (!tournament || tournament.config_competencia?.amistoso !== true || String(tournament.rama_id) !== String(branch.id)) {
        return res.status(409).json({ error: 'La competencia seleccionada no es un amistoso válido para esta rama.' });
      }
    }

    const { data, error } = await supabase.from('partidos').insert({
      academia_id: req.user.academia_id,
      torneo_id: tournamentId,
      sede_id: branch.sede_id,
      rama_id: branch.id,
      categoria_id: category.id,
      disciplina_codigo: String(branch.disciplina || 'otro').toLowerCase(),
      rival: reference,
      fecha: req.body.fecha,
      hora: req.body.hora,
      hora_citacion: req.body?.hora_citacion || null,
      ubicacion: safeText(req.body?.ubicacion, 300) || null,
      link_maps: safeText(req.body?.link_maps, 1000) || null,
      condicion: safeText(req.body?.condicion, 40) || null,
      es_amistoso: true,
      estado: 'Programado',
      en_vivo: false,
      temporada: String(req.body.fecha).slice(0, 4),
    }).select('id,torneo_id,rival,fecha,hora,hora_citacion,ubicacion,condicion,estado,categoria_id,rama_id,sede_id,es_amistoso').single();
    if (error) throw error;
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible programar el amistoso.' });
  }
});

router.patch('/amistosos/eventos/:id', authMiddleware, requireDirector, async (req, res) => {
  try {
    await assertFriendlies(req.user.academia_id);
    const changes = {};
    for (const key of ['fecha','hora','hora_citacion']) if (req.body?.[key] !== undefined) changes[key] = req.body[key] || null;
    for (const [key, max] of [['rival',180],['ubicacion',300],['link_maps',1000],['condicion',40],['estado',40]]) {
      if (req.body?.[key] !== undefined) changes[key] = safeText(req.body[key], max) || null;
    }
    const { data, error } = await supabase.from('partidos').update(changes)
      .eq('id', req.params.id).eq('academia_id', req.user.academia_id).eq('es_amistoso', true)
      .select('id,rival,fecha,hora,hora_citacion,ubicacion,condicion,estado').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Amistoso no encontrado.' });
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible actualizar el amistoso.' });
  }
});

module.exports = router;
