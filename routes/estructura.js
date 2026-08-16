const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { getAcademyEntitlements } = require('../services/planCatalog');

const router = express.Router();
router.use(authMiddleware, requireDirector);

const safeText = (value, max = 180) => String(value ?? '').trim().slice(0, max);
const ALLOWED_DISCIPLINES = ['Fútbol','Futsal','Básquetbol','Vóleibol','Tenis','Pádel','Hockey','Atletismo','Natación','Gimnasia','Artes marciales','Rugby','Otro'];

const assertSite = async (academyId, siteId) => {
  const { data, error } = await supabase.from('sedes').select('*').eq('id', siteId).eq('academia_id', academyId).maybeSingle();
  if (error) throw error;
  if (!data) { const err = new Error('Sede no encontrada.'); err.status = 404; throw err; }
  return data;
};

const getStructureEntitlements = async (academyId) => {
  const { data, error } = await supabase.from('academias')
    .select('id,plan,plan_codigo,max_profesores,licencia_apoderados')
    .eq('id', academyId)
    .single();
  if (error || !data) {
    const err = new Error('No fue posible validar el plan de la academia.');
    err.status = 404;
    throw err;
  }
  return getAcademyEntitlements(data);
};

const assertStructureCapacity = async (academyId, kind) => {
  const entitlements = await getStructureEntitlements(academyId);
  const isSite = kind === 'sites';
  const limit = entitlements.limits[kind];
  if (!Number.isInteger(limit)) return entitlements;

  const table = isSite ? 'sedes' : 'ramas';
  const { count, error } = await supabase.from(table)
    .select('id', { count: 'exact', head: true })
    .eq('academia_id', academyId)
    .eq('activa', true);
  if (error) throw error;

  if (Number(count || 0) >= limit) {
    const err = new Error(isSite
      ? `Tu plan ${entitlements.plan.name} permite hasta ${limit} sede${limit === 1 ? '' : 's'} activa${limit === 1 ? '' : 's'}.`
      : `Tu plan ${entitlements.plan.name} permite hasta ${limit} rama${limit === 1 ? '' : 's'} activa${limit === 1 ? '' : 's'}.`);
    err.status = 403;
    err.code = isSite ? 'SITE_LIMIT_REACHED' : 'BRANCH_LIMIT_REACHED';
    throw err;
  }
  return entitlements;
};

router.get('/', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const [
      { data: sites, error: siteError },
      { data: branches, error: branchError },
      entitlements,
    ] = await Promise.all([
      supabase.from('sedes').select('*').eq('academia_id', academyId).order('principal', { ascending: false }).order('nombre'),
      supabase.from('ramas').select('*').eq('academia_id', academyId).order('principal', { ascending: false }).order('nombre'),
      getStructureEntitlements(academyId),
    ]);
    if (siteError) throw siteError;
    if (branchError) throw branchError;
    const data = (sites || []).map((site) => ({ ...site, ramas: (branches || []).filter((branch) => branch.sede_id === site.id) }));
    res.json({
      success: true,
      data,
      disciplines: ALLOWED_DISCIPLINES,
      limits: {
        sites: entitlements.limits.sites,
        branches: entitlements.limits.branches,
        plan: entitlements.plan,
      },
    });
  } catch (error) {
    console.error('Error cargando estructura:', error?.message || 'Error desconocido');
    res.status(error?.status || 500).json({ error: error?.message || 'No fue posible cargar sedes y ramas.' });
  }
});

router.post('/sedes', async (req, res) => {
  try {
    const nombre = safeText(req.body?.nombre);
    if (!nombre) return res.status(400).json({ error: 'El nombre de la sede es obligatorio.' });
    await assertStructureCapacity(req.user.academia_id, 'sites');

    const payload = {
      academia_id: req.user.academia_id,
      nombre,
      codigo: safeText(req.body?.codigo, 40) || null,
      direccion: safeText(req.body?.direccion, 300) || null,
      ciudad: safeText(req.body?.ciudad, 120) || null,
      comuna: safeText(req.body?.comuna, 120) || null,
      region: safeText(req.body?.region, 120) || null,
      pais: safeText(req.body?.pais, 80) || 'Chile',
      telefono: safeText(req.body?.telefono, 50) || null,
      ubicacion_entrenamiento: safeText(req.body?.ubicacion_entrenamiento, 300) || null,
      dias_entrenamiento: safeText(req.body?.dias_entrenamiento, 500) || null,
      horarios_entrenamiento: safeText(req.body?.horarios_entrenamiento, 500) || null,
      principal: Boolean(req.body?.principal),
      activa: req.body?.activa !== false,
    };
    if (payload.principal) await supabase.from('sedes').update({ principal: false }).eq('academia_id', req.user.academia_id);
    const { data, error } = await supabase.from('sedes').insert(payload).select('*').single();
    if (error) throw error;
    if (payload.principal || !(await supabase.from('sedes').select('id', { count: 'exact', head: true }).eq('academia_id', req.user.academia_id)).count) {
      await supabase.from('sedes').update({ principal: true }).eq('id', data.id);
    }
    res.status(201).json({ success: true, data });
  } catch (error) {
    const duplicate = error?.code === '23505';
    res.status(error?.status || (duplicate ? 409 : 500)).json({
      error: duplicate ? 'Ya existe una sede con ese nombre.' : error?.message || 'No fue posible crear la sede.',
      code: error?.code || undefined,
    });
  }
});

router.patch('/sedes/:id', async (req, res) => {
  try {
    const current = await assertSite(req.user.academia_id, req.params.id);
    if (current.activa === false && req.body?.activa === true) {
      await assertStructureCapacity(req.user.academia_id, 'sites');
    }
    const changes = {};
    ['nombre','codigo','direccion','ciudad','comuna','region','pais','telefono','ubicacion_entrenamiento','dias_entrenamiento','horarios_entrenamiento'].forEach((key) => {
      if (req.body?.[key] !== undefined) changes[key] = safeText(req.body[key], key === 'nombre' ? 180 : 500) || null;
    });
    if (req.body?.activa !== undefined) changes.activa = Boolean(req.body.activa);
    if (req.body?.principal === true) {
      await supabase.from('sedes').update({ principal: false }).eq('academia_id', req.user.academia_id);
      changes.principal = true;
    }
    changes.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from('sedes').update(changes).eq('id', req.params.id).eq('academia_id', req.user.academia_id).select('*').single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(error?.status || (error?.code === '23505' ? 409 : 500)).json({
      error: error?.code === '23505' ? 'Ya existe una sede con ese nombre.' : error?.message || 'No fue posible actualizar la sede.',
      code: error?.code || undefined,
    });
  }
});

router.post('/ramas', async (req, res) => {
  try {
    const sedeId = safeText(req.body?.sede_id, 80);
    const nombre = safeText(req.body?.nombre);
    const disciplina = safeText(req.body?.disciplina) || nombre;
    if (!sedeId || !nombre) return res.status(400).json({ error: 'Selecciona sede e ingresa el nombre de la rama.' });
    await assertSite(req.user.academia_id, sedeId);
    await assertStructureCapacity(req.user.academia_id, 'branches');

    const payload = { academia_id: req.user.academia_id, sede_id: sedeId, nombre, disciplina, descripcion: safeText(req.body?.descripcion, 500) || null, activa: req.body?.activa !== false, principal: Boolean(req.body?.principal) };
    if (payload.principal) await supabase.from('ramas').update({ principal: false }).eq('sede_id', sedeId);
    const { data, error } = await supabase.from('ramas').insert(payload).select('*').single();
    if (error) throw error;
    const { count } = await supabase.from('ramas').select('id', { count: 'exact', head: true }).eq('sede_id', sedeId);
    if (count === 1) await supabase.from('ramas').update({ principal: true }).eq('id', data.id);
    res.status(201).json({ success: true, data });
  } catch (error) {
    const duplicate = error?.code === '23505';
    res.status(error?.status || (duplicate ? 409 : 500)).json({
      error: duplicate ? 'Ya existe esa rama en la sede.' : error?.message || 'No fue posible crear la rama.',
      code: error?.code || undefined,
    });
  }
});

router.patch('/ramas/:id', async (req, res) => {
  try {
    const { data: current, error: currentError } = await supabase.from('ramas').select('*').eq('id', req.params.id).eq('academia_id', req.user.academia_id).maybeSingle();
    if (currentError) throw currentError;
    if (!current) return res.status(404).json({ error: 'Rama no encontrada.' });
    if (current.activa === false && req.body?.activa === true) {
      await assertStructureCapacity(req.user.academia_id, 'branches');
    }
    const changes = {};
    ['nombre','disciplina','descripcion'].forEach((key) => { if (req.body?.[key] !== undefined) changes[key] = safeText(req.body[key], key === 'descripcion' ? 500 : 180) || null; });
    if (req.body?.activa !== undefined) changes.activa = Boolean(req.body.activa);
    if (req.body?.principal === true) {
      await supabase.from('ramas').update({ principal: false }).eq('sede_id', current.sede_id);
      changes.principal = true;
    }
    changes.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from('ramas').update(changes).eq('id', current.id).select('*').single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(error?.status || (error?.code === '23505' ? 409 : 500)).json({
      error: error?.code === '23505' ? 'Ya existe esa rama en la sede.' : error?.message || 'No fue posible actualizar la rama.',
      code: error?.code || undefined,
    });
  }
});

router.get('/resumen', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const { data: players, error } = await supabase.from('jugadores').select('id,sede_id,rama_id').eq('academia_id', academyId);
    if (error) throw error;
    const counts = {};
    (players || []).forEach((p) => { const key = `${p.sede_id || 'sin'}:${p.rama_id || 'sin'}`; counts[key] = (counts[key] || 0) + 1; });
    res.json({ success: true, data: counts });
  } catch (_error) { res.status(500).json({ error: 'No fue posible cargar el resumen.' }); }
});

module.exports = router;
