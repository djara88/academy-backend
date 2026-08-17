const supabase = require('../config/supabase');

const ALLOWED_DISCIPLINES = Object.freeze([
  'Fútbol', 'Futsal', 'Básquetbol', 'Vóleibol', 'Tenis', 'Pádel', 'Hockey',
  'Atletismo', 'Natación', 'Gimnasia', 'Karate', 'Artes marciales', 'Rugby', 'Otro',
]);

const normalizeText = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase();

const disciplineMap = new Map(ALLOWED_DISCIPLINES.map((item) => [normalizeText(item), item]));
const aliases = new Map([
  ['futbol', 'Fútbol'], ['football', 'Fútbol'], ['basket', 'Básquetbol'], ['basketbol', 'Básquetbol'],
  ['basquet', 'Básquetbol'], ['volley', 'Vóleibol'], ['voleibol', 'Vóleibol'], ['tennis', 'Tenis'],
  ['padel', 'Pádel'], ['natacion', 'Natación'], ['gimnasia', 'Gimnasia'], ['karate-do', 'Karate'],
  ['karate do', 'Karate'], ['artes marciales', 'Artes marciales'],
]);

const resolveDiscipline = (value) => {
  const key = normalizeText(value);
  return disciplineMap.get(key) || aliases.get(key) || null;
};

const sanitizeName = (value, fallback, max = 180) => String(value || fallback || '').trim().replace(/\s+/g, ' ').slice(0, max);

const defaultBranchName = (discipline) => discipline === 'Otro' ? 'Disciplina principal' : discipline;

const createInitialStructure = async ({ academyId, discipline, branchName, siteName, address } = {}) => {
  const resolvedDiscipline = resolveDiscipline(discipline);
  if (!resolvedDiscipline) {
    const error = new Error('Selecciona una disciplina principal válida.');
    error.status = 400;
    error.code = 'INVALID_PRIMARY_DISCIPLINE';
    throw error;
  }

  const cleanSiteName = sanitizeName(siteName, 'Sede Principal');
  const cleanBranchName = sanitizeName(branchName, defaultBranchName(resolvedDiscipline));
  const cleanAddress = sanitizeName(address, '', 300) || null;
  let site = null;
  let branch = null;

  try {
    const { data: createdSite, error: siteError } = await supabase.from('sedes').insert({
      academia_id: academyId,
      nombre: cleanSiteName,
      direccion: cleanAddress,
      pais: 'Chile',
      principal: true,
      activa: true,
    }).select('*').single();
    if (siteError) throw siteError;
    site = createdSite;

    const { data: createdBranch, error: branchError } = await supabase.from('ramas').insert({
      academia_id: academyId,
      sede_id: site.id,
      nombre: cleanBranchName,
      disciplina: resolvedDiscipline,
      principal: true,
      activa: true,
    }).select('*').single();
    if (branchError) throw branchError;
    branch = createdBranch;

    const { error: academyError } = await supabase.from('academias')
      .update({ rama_principal_id: branch.id })
      .eq('id', academyId);
    if (academyError) throw academyError;

    return { site, branch, discipline: resolvedDiscipline };
  } catch (error) {
    if (branch?.id) await supabase.from('ramas').delete().eq('id', branch.id).eq('academia_id', academyId);
    if (site?.id) await supabase.from('sedes').delete().eq('id', site.id).eq('academia_id', academyId);
    throw error;
  }
};

const setPrimaryBranch = async (academyId, branchId) => {
  const { data: branch, error } = await supabase.from('ramas')
    .select('id,nombre,disciplina,sede_id,activa,sedes(id,nombre,activa)')
    .eq('id', branchId)
    .eq('academia_id', academyId)
    .maybeSingle();
  if (error) throw error;
  if (!branch || branch.activa === false || branch.sedes?.activa === false) {
    const scopedError = new Error('La rama principal debe estar activa y pertenecer a tu academia.');
    scopedError.status = 400;
    scopedError.code = 'INVALID_PRIMARY_BRANCH';
    throw scopedError;
  }

  const { data: academy, error: updateError } = await supabase.from('academias')
    .update({ rama_principal_id: branch.id })
    .eq('id', academyId)
    .select('id,rama_principal_id')
    .single();
  if (updateError) throw updateError;
  return { academy, branch };
};

module.exports = {
  ALLOWED_DISCIPLINES,
  resolveDiscipline,
  defaultBranchName,
  createInitialStructure,
  setPrimaryBranch,
};
