const supabase = require('../config/supabase');
const { scopedError, assertSameBranch } = require('./branchScopeRules');

const safeText = (value, max = 180) => String(value ?? '').trim().slice(0, max);
const uniqueIds = (values) => [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))];

const getBranch = async (academyId, branchId, { activeOnly = true } = {}) => {
  const id = safeText(branchId, 80);
  if (!id) throw scopedError('Selecciona una rama deportiva.', 400, 'BRANCH_REQUIRED');
  let query = supabase.from('ramas')
    .select('id,academia_id,sede_id,nombre,disciplina,descripcion,principal,activa,sedes(id,nombre,principal,activa)')
    .eq('id', id)
    .eq('academia_id', academyId);
  if (activeOnly) query = query.eq('activa', true);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) throw scopedError('La rama seleccionada no pertenece a la academia o está inactiva.', 404, 'BRANCH_NOT_FOUND');
  return data;
};

const getCategoryContext = async (academyId, categoryId, { requireScoped = true } = {}) => {
  const id = safeText(categoryId, 80);
  if (!id) throw scopedError('Selecciona una categoría.', 400, 'CATEGORY_REQUIRED');
  const { data: category, error } = await supabase.from('categorias')
    .select('id,academia_id,nombre,descripcion,sede_id,rama_id')
    .eq('id', id)
    .eq('academia_id', academyId)
    .maybeSingle();
  if (error) throw error;
  if (!category) throw scopedError('La categoría seleccionada no pertenece a la academia.', 404, 'CATEGORY_NOT_FOUND');
  if (requireScoped && (!category.rama_id || !category.sede_id)) {
    throw scopedError('La categoría todavía no está vinculada a una sede y rama. Corrígela en Estructura.', 409, 'CATEGORY_NOT_SCOPED');
  }
  let branch = null;
  if (category.rama_id) branch = await getBranch(academyId, category.rama_id, { activeOnly: false });
  if (requireScoped && branch && String(branch.sede_id) !== String(category.sede_id)) {
    throw scopedError('La categoría tiene una sede que no coincide con su rama.', 409, 'CATEGORY_SCOPE_MISMATCH');
  }
  return { category, branch, site: branch?.sedes || null };
};

const getCategoryMemberIds = async (categoryId, playerIds) => {
  const requestedIds = uniqueIds(playerIds);
  let query = supabase.from('jugador_categoria')
    .select('jugador_id')
    .eq('categoria_id', categoryId);
  if (requestedIds.length) query = query.in('jugador_id', requestedIds);
  const { data, error } = await query;
  if (error) throw error;
  return uniqueIds((data || []).map((row) => row.jugador_id));
};

const getTournament = async (academyId, tournamentId) => {
  const id = safeText(tournamentId, 80);
  if (!id) throw scopedError('Selecciona un torneo.', 400, 'TOURNAMENT_REQUIRED');
  const { data, error } = await supabase.from('torneos')
    .select('*,ramas(id,nombre,disciplina,sede_id),sedes(id,nombre)')
    .eq('id', id)
    .eq('academia_id', academyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw scopedError('Torneo no encontrado en la academia.', 404, 'TOURNAMENT_NOT_FOUND');
  return data;
};

// La inscripción deportiva representa la pertenencia a una rama. Las categorías
// son una relación muchos-a-muchos mediante jugador_categoria. categoria_id en
// inscripciones_deportivas se conserva únicamente como categoría de referencia
// para compatibilidad con módulos históricos; nunca debe limitar membresías.
const getActiveEnrollments = async ({ academyId, branchId, categoryId, playerIds } = {}) => {
  const requestedIds = uniqueIds(playerIds);
  let effectiveBranchId = safeText(branchId, 80) || null;
  let effectivePlayerIds = requestedIds;

  if (categoryId) {
    const { category } = await getCategoryContext(academyId, categoryId);
    if (effectiveBranchId && String(effectiveBranchId) !== String(category.rama_id)) {
      throw scopedError('La categoría no pertenece a la rama seleccionada.', 409, 'CATEGORY_BRANCH_MISMATCH');
    }
    effectiveBranchId = category.rama_id;
    effectivePlayerIds = await getCategoryMemberIds(category.id, requestedIds);
    if (!effectivePlayerIds.length) return [];
  }

  let query = supabase.from('inscripciones_deportivas')
    .select('id,jugador_id,sede_id,rama_id,categoria_id,estado,es_principal,rol_especialidad,fecha_inicio,fecha_fin,monto_matricula,monto_mensualidad')
    .eq('academia_id', academyId)
    .eq('estado', 'Activa');
  if (effectiveBranchId) query = query.eq('rama_id', effectiveBranchId);
  if (effectivePlayerIds.length) query = query.in('jugador_id', effectivePlayerIds);
  const { data, error } = await query.order('es_principal', { ascending: false }).order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
};

const getPlayersForEnrollments = async (academyId, enrollments, select = 'id,nombre,rut,rut_pasaporte,numero_documento,fecha_nacimiento,foto_base64,foto_url,avatar_url,tutor_id,telefono,alerta_medica,telefono_emergencia') => {
  const ids = uniqueIds((enrollments || []).map((row) => row.jugador_id));
  if (!ids.length) return [];
  const { data, error } = await supabase.from('jugadores')
    .select(select)
    .eq('academia_id', academyId)
    .in('id', ids)
    .order('nombre');
  if (error) throw error;
  return data || [];
};

const getStudentsForScope = async ({ academyId, branchId, categoryId, playerIds, playerSelect } = {}) => {
  const enrollments = await getActiveEnrollments({ academyId, branchId, categoryId, playerIds });
  const players = await getPlayersForEnrollments(academyId, enrollments, playerSelect);
  const enrollmentMap = new Map();
  for (const enrollment of enrollments) {
    if (!enrollmentMap.has(String(enrollment.jugador_id))) enrollmentMap.set(String(enrollment.jugador_id), enrollment);
  }
  return players.map((player) => ({ ...player, inscripcion: enrollmentMap.get(String(player.id)) || null }));
};

const getStudentEnrollment = async (academyId, playerId, { branchId, categoryId, activeOnly = true } = {}) => {
  let effectiveBranchId = safeText(branchId, 80) || null;

  if (categoryId) {
    const { category } = await getCategoryContext(academyId, categoryId);
    if (effectiveBranchId && String(effectiveBranchId) !== String(category.rama_id)) {
      throw scopedError('La categoría no pertenece a la rama seleccionada.', 409, 'CATEGORY_BRANCH_MISMATCH');
    }
    const memberIds = await getCategoryMemberIds(category.id, [playerId]);
    if (!memberIds.length) {
      throw scopedError('El alumno no pertenece a la categoría seleccionada.', 409, 'CATEGORY_MEMBERSHIP_REQUIRED');
    }
    effectiveBranchId = category.rama_id;
  }

  let query = supabase.from('inscripciones_deportivas')
    .select('id,jugador_id,sede_id,rama_id,categoria_id,estado,es_principal,rol_especialidad,monto_matricula,monto_mensualidad')
    .eq('academia_id', academyId)
    .eq('jugador_id', playerId);
  if (activeOnly) query = query.eq('estado', 'Activa');
  if (effectiveBranchId) query = query.eq('rama_id', effectiveBranchId);
  const { data, error } = await query.order('es_principal', { ascending: false }).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (error) throw error;
  if (!data) throw scopedError('El alumno no tiene una inscripción activa en la rama seleccionada.', 409, 'ACTIVE_ENROLLMENT_REQUIRED');
  return data;
};

const listAcademyBranches = async (academyId, { activeOnly = true } = {}) => {
  let query = supabase.from('ramas')
    .select('id,sede_id,nombre,disciplina,principal,activa,sedes(id,nombre,principal,activa)')
    .eq('academia_id', academyId)
    .order('principal', { ascending: false })
    .order('nombre');
  if (activeOnly) query = query.eq('activa', true);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};

module.exports = {
  safeText,
  uniqueIds,
  scopedError,
  getBranch,
  getCategoryContext,
  getCategoryMemberIds,
  getTournament,
  assertSameBranch,
  getActiveEnrollments,
  getPlayersForEnrollments,
  getStudentsForScope,
  getStudentEnrollment,
  listAcademyBranches,
};
