const supabase = require('../config/supabase');
const { getConsentCatalog } = require('./privacyConsents');

const SETUP_VERSION = '2026.1';
const OPTIONAL_CONSENTS = ['datos_salud', 'imagen_interna', 'imagen_publica'];

const isText = (value) => Boolean(String(value || '').trim());
const asBoolDecision = (value) => typeof value === 'boolean';
const getScheduleBlocks = (site) => Array.isArray(site?.horarios_config)
  ? site.horarios_config.filter((item) => item && typeof item === 'object')
  : [];
const hasScheduleDays = (site) => {
  const blocks = getScheduleBlocks(site);
  return blocks.length > 0 ? blocks.every((item) => isText(item.dias)) : isText(site?.dias_entrenamiento);
};
const hasScheduleTimes = (site) => {
  const blocks = getScheduleBlocks(site);
  return blocks.length > 0
    ? blocks.every((item) => isText(item.inicio) && isText(item.fin))
    : isText(site?.horarios_entrenamiento);
};

const getSetupRecord = async (academyId) => {
  const { data, error } = await supabase
    .from('academy_setup')
    .select('*')
    .eq('academia_id', academyId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
};

const updateSetupPreferences = async (academyId, patch = {}) => {
  const current = await getSetupRecord(academyId);
  if (!current) {
    const error = new Error('Esta academia no utiliza la Puesta en Marcha guiada.');
    error.status = 409;
    error.code = 'SETUP_NOT_REQUIRED';
    throw error;
  }

  const changes = { updated_at: new Date().toISOString() };

  if (Object.prototype.hasOwnProperty.call(patch, 'billing_choice')) {
    if (typeof patch.billing_choice !== 'boolean') {
      const error = new Error('Indica si administrarás cobros con Lestra.');
      error.status = 400;
      throw error;
    }
    changes.billing_choice = patch.billing_choice;
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'staff_mode')) {
    if (!['solo', 'team'].includes(patch.staff_mode)) {
      const error = new Error('La modalidad de equipo debe ser solo o team.');
      error.status = 400;
      throw error;
    }
    changes.staff_mode = patch.staff_mode;
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'terms_choice')) {
    if (!['custom', 'none'].includes(patch.terms_choice)) {
      const error = new Error('Indica si tu academia utilizará términos propios.');
      error.status = 400;
      throw error;
    }
    changes.terms_choice = patch.terms_choice;
  }

  if (patch.consent_settings && typeof patch.consent_settings === 'object' && !Array.isArray(patch.consent_settings)) {
    const merged = { ...(current.consent_settings || {}), aviso_privacidad: true };
    for (const type of OPTIONAL_CONSENTS) {
      if (!Object.prototype.hasOwnProperty.call(patch.consent_settings, type)) continue;
      if (typeof patch.consent_settings[type] !== 'boolean') {
        const error = new Error('Cada consentimiento opcional debe indicarse como incluir o no incluir.');
        error.status = 400;
        throw error;
      }
      merged[type] = patch.consent_settings[type];
    }
    changes.consent_settings = merged;
  }

  const { data, error } = await supabase
    .from('academy_setup')
    .update(changes)
    .eq('academia_id', academyId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
};

const buildSetupStatus = async (academyId) => {
  const setup = await getSetupRecord(academyId);
  if (!setup) {
    return {
      required: false,
      locked: false,
      operational: true,
      completed_once: true,
      progress: 100,
      version: null,
      steps: [],
      setup: null,
      message: 'Academia existente: la Puesta en Marcha guiada no es obligatoria.',
    };
  }

  const [academyResult, sitesResult, branchesResult, categoriesResult, financeResult, professorsResult, assignmentsResult, playersResult] = await Promise.all([
    supabase.from('academias')
      .select('id,nombre,nombre_director,director_email,correo_academia,direccion,telefono,terminos_condiciones,terminos_matricula,rama_principal_id,subdominio,pagina_publica_activa')
      .eq('id', academyId).single(),
    supabase.from('sedes')
      .select('id,nombre,direccion,ubicacion_entrenamiento,dias_entrenamiento,horarios_entrenamiento,horarios_config,principal,activa')
      .eq('academia_id', academyId).order('principal', { ascending: false }).order('created_at'),
    supabase.from('ramas')
      .select('id,nombre,disciplina,sede_id,principal,activa')
      .eq('academia_id', academyId).order('principal', { ascending: false }).order('created_at'),
    supabase.from('categorias')
      .select('id,nombre,rama_id,sede_id')
      .eq('academia_id', academyId).order('nombre'),
    supabase.from('configuracion_financiera')
      .select('academia_id,acepta_efectivo,acepta_transferencia,acepta_pago_online,transferencia_banco,transferencia_tipo_cuenta,transferencia_numero,transferencia_rut')
      .eq('academia_id', academyId).maybeSingle(),
    supabase.from('usuarios')
      .select('id,nombre_completo,nombre,email,correo,activo')
      .eq('academia_id', academyId).eq('rol', 'profesor').eq('activo', true),
    supabase.from('profesor_categorias')
      .select('profesor_id,categoria_id,activo')
      .eq('academia_id', academyId).eq('activo', true),
    supabase.from('jugadores')
      .select('id', { count: 'exact', head: true })
      .eq('academia_id', academyId),
  ]);

  for (const result of [academyResult, sitesResult, branchesResult, categoriesResult, financeResult, professorsResult, assignmentsResult, playersResult]) {
    if (result.error) throw result.error;
  }

  const academy = academyResult.data;
  const sites = (sitesResult.data || []).filter((site) => site.activa !== false);
  const branches = (branchesResult.data || []).filter((branch) => branch.activa !== false);
  const categories = categoriesResult.data || [];
  const finance = financeResult.data || null;
  const professors = professorsResult.data || [];
  const assignments = assignmentsResult.data || [];

  const categoriesByBranch = new Map();
  for (const category of categories) {
    const key = String(category.rama_id || '');
    if (!key) continue;
    const list = categoriesByBranch.get(key) || [];
    list.push(category);
    categoriesByBranch.set(key, list);
  }

  const branchesBySite = new Map();
  for (const branch of branches) {
    const key = String(branch.sede_id || '');
    const list = branchesBySite.get(key) || [];
    list.push({ ...branch, categorias: categoriesByBranch.get(String(branch.id)) || [] });
    branchesBySite.set(key, list);
  }

  const structureSites = sites.map((site) => ({
    ...site,
    operation_complete: Boolean(
      (isText(site.direccion) || isText(site.ubicacion_entrenamiento))
      && hasScheduleDays(site)
      && hasScheduleTimes(site)
    ),
    ramas: branchesBySite.get(String(site.id)) || [],
  }));

  const identityChecks = {
    academy_name: isText(academy?.nombre),
    director: isText(academy?.nombre_director),
    email: isText(academy?.director_email || academy?.correo_academia),
  };
  const identityComplete = Object.values(identityChecks).every(Boolean);

  const primaryBranchActive = Boolean(academy?.rama_principal_id && branches.some((branch) => String(branch.id) === String(academy.rama_principal_id)));
  const everyBranchHasCategory = branches.length > 0 && branches.every((branch) => (categoriesByBranch.get(String(branch.id)) || []).length > 0);
  const structureChecks = {
    site: sites.length > 0,
    branch: branches.length > 0,
    primary_branch: primaryBranchActive,
    categories: everyBranchHasCategory,
  };
  const structureComplete = Object.values(structureChecks).every(Boolean);

  const operationChecks = {
    locations: sites.length > 0 && sites.every((site) => isText(site.direccion) || isText(site.ubicacion_entrenamiento)),
    days: sites.length > 0 && sites.every(hasScheduleDays),
    schedules: sites.length > 0 && sites.every(hasScheduleTimes),
  };
  const operationComplete = Object.values(operationChecks).every(Boolean);

  const financeChoiceMade = typeof setup.billing_choice === 'boolean';
  const transferReady = Boolean(finance?.acepta_transferencia
    && isText(finance.transferencia_banco)
    && isText(finance.transferencia_tipo_cuenta)
    && isText(finance.transferencia_numero)
    && isText(finance.transferencia_rut));
  const financeMethodReady = Boolean(finance?.acepta_efectivo || transferReady || finance?.acepta_pago_online);
  const financeChecks = {
    decision: financeChoiceMade,
    method: setup.billing_choice === false ? true : Boolean(setup.billing_choice === true && financeMethodReady),
  };
  const financeComplete = Object.values(financeChecks).every(Boolean);

  const customTerms = academy?.terminos_condiciones || academy?.terminos_matricula || '';
  const termsDecisionReady = ['custom', 'none'].includes(setup.terms_choice);
  const termsReady = setup.terms_choice === 'none' ? true : setup.terms_choice === 'custom' ? isText(customTerms) : false;
  const consentSettings = { ...(setup.consent_settings || {}), aviso_privacidad: true };
  const consentDecisionReady = OPTIONAL_CONSENTS.every((type) => asBoolDecision(consentSettings[type]));
  const rulesChecks = {
    terms_decision: termsDecisionReady,
    terms_content: termsReady,
    consent_decisions: consentDecisionReady,
    privacy_notice: true,
  };
  const rulesComplete = Object.values(rulesChecks).every(Boolean);

  const teamDecisionReady = ['solo', 'team'].includes(setup.staff_mode);
  const activeProfessorIds = new Set(professors.map((professor) => String(professor.id)));
  const assignedProfessorIds = new Set(assignments.filter((assignment) => activeProfessorIds.has(String(assignment.profesor_id))).map((assignment) => String(assignment.profesor_id)));
  const teamChecks = {
    decision: teamDecisionReady,
    professor: setup.staff_mode === 'solo' ? true : setup.staff_mode === 'team' ? professors.length > 0 : false,
    assignment: setup.staff_mode === 'solo' ? true : setup.staff_mode === 'team' ? assignedProfessorIds.size > 0 : false,
  };
  const teamComplete = Object.values(teamChecks).every(Boolean);

  const steps = [
    { key: 'identity', number: '01', title: 'Tu identidad', subtitle: 'Quién administra la academia.', complete: identityComplete, checks: identityChecks },
    { key: 'structure', number: '02', title: 'Tu estructura', subtitle: 'Sedes, deportes y categorías.', complete: structureComplete, checks: structureChecks },
    { key: 'operation', number: '03', title: 'Tu operación', subtitle: 'Dónde y cuándo entrenan.', complete: operationComplete, checks: operationChecks },
    { key: 'finance', number: '04', title: 'Tus cobros', subtitle: 'Cómo recibirá pagos la academia.', complete: financeComplete, checks: financeChecks },
    { key: 'rules', number: '05', title: 'Tus reglas', subtitle: 'Términos y autorizaciones.', complete: rulesComplete, checks: rulesChecks },
    { key: 'team', number: '06', title: 'Tu equipo', subtitle: 'Quién trabaja contigo.', complete: teamComplete, checks: teamChecks },
  ];

  const completeCount = steps.filter((step) => step.complete).length;
  const operational = completeCount === steps.length;
  let completedAt = setup.completed_at || null;
  if (operational && !completedAt) {
    completedAt = new Date().toISOString();
    const { error } = await supabase.from('academy_setup')
      .update({ completed_at: completedAt, updated_at: completedAt })
      .eq('academia_id', academyId);
    if (error) throw error;
  }

  const completedOnce = Boolean(completedAt);
  const locked = !completedOnce && !operational;
  const publicPageReady = Boolean(academy?.subdominio && academy?.pagina_publica_activa);
  const optional = {
    students: { complete: Number(playersResult.count || 0) > 0, label: 'Primeros alumnos' },
    public_page: { complete: publicPageReady, label: 'Página pública' },
    online_payments: { complete: Boolean(finance?.acepta_pago_online), label: 'Pago online' },
  };
  const optionalValues = Object.values(optional);
  const adoptionProgress = optionalValues.length ? Math.round((optionalValues.filter((item) => item.complete).length / optionalValues.length) * 100) : 0;

  return {
    required: true,
    locked,
    operational,
    completed_once: completedOnce,
    progress: Math.round((completeCount / steps.length) * 100),
    adoption_progress: adoptionProgress,
    version: setup.version || SETUP_VERSION,
    completed_at: completedAt,
    setup: {
      billing_choice: setup.billing_choice,
      staff_mode: setup.staff_mode,
      terms_choice: setup.terms_choice,
      consent_settings: consentSettings,
    },
    academy: {
      id: academy.id,
      nombre: academy.nombre,
      director: academy.nombre_director,
      email: academy.director_email || academy.correo_academia || null,
      terms_configured: isText(customTerms),
    },
    structure: {
      sites: structureSites,
      primary_branch_id: academy.rama_principal_id || null,
    },
    finance: finance || null,
    team: {
      professors_count: professors.length,
      assigned_professors_count: assignedProfessorIds.size,
    },
    optional,
    steps,
  };
};

const getAcademyConsentCatalog = async (academyId, academyName = 'la academia') => {
  const setup = await getSetupRecord(academyId);
  if (!setup) return getConsentCatalog(academyName);
  const settings = setup.consent_settings || {};
  const enabledTypes = OPTIONAL_CONSENTS.filter((type) => settings[type] === true);
  return getConsentCatalog(academyName, { enabledTypes });
};

module.exports = {
  SETUP_VERSION,
  OPTIONAL_CONSENTS,
  getSetupRecord,
  updateSetupPreferences,
  buildSetupStatus,
  getAcademyConsentCatalog,
};