const supabase = require('../config/supabase');
const {
  getBranch,
  getCategoryContext,
  getActiveEnrollments,
  getPlayersForEnrollments,
  getStudentEnrollment,
  safeText,
} = require('./branchContext');
const {
  MIN_JERSEY_NUMBER,
  MAX_JERSEY_NUMBER,
  normalizeJerseyNumber,
  buildJerseyMap,
} = require('./jerseyNumberRules');

const ACTIVE_PRE_ENROLLMENT_STATUSES = ['enviada', 'abierta'];

const resolveJerseyScope = async ({ academyId, branchId, categoryId }) => {
  const branch = await getBranch(academyId, branchId);
  let category = null;
  if (categoryId) {
    const context = await getCategoryContext(academyId, categoryId);
    category = context.category;
    if (String(category.rama_id) !== String(branch.id)) {
      const error = new Error('La categoría no pertenece a la rama seleccionada.');
      error.status = 409;
      error.code = 'CATEGORY_BRANCH_MISMATCH';
      throw error;
    }
  }
  return { branch, category };
};

const listJerseyNumbers = async ({
  academyId,
  branchId,
  categoryId = null,
  excludePrematriculaId = null,
  excludePlayerId = null,
} = {}) => {
  const cleanBranchId = safeText(branchId, 80);
  const cleanCategoryId = safeText(categoryId, 80) || null;
  const excludedPre = safeText(excludePrematriculaId, 80) || null;
  const excludedPlayer = safeText(excludePlayerId, 80) || null;
  const { branch, category } = await resolveJerseyScope({ academyId, branchId: cleanBranchId, categoryId: cleanCategoryId });

  const enrollments = await getActiveEnrollments({
    academyId,
    branchId: branch.id,
    categoryId: category?.id || undefined,
  });
  const scopedEnrollments = excludedPlayer
    ? enrollments.filter((item) => String(item.jugador_id) !== String(excludedPlayer))
    : enrollments;
  const players = await getPlayersForEnrollments(
    academyId,
    scopedEnrollments,
    'id,nombre,numero_camiseta',
  );
  const assigned = players
    .filter((player) => player.numero_camiseta != null)
    .map((player) => ({ id: player.id, nombre: player.nombre, numero: player.numero_camiseta }));

  const { data: preEnrollments, error: preError } = await supabase.from('prematriculas')
    .select('id,estado,jugador_payload,created_at')
    .eq('academia_id', academyId)
    .in('estado', ACTIVE_PRE_ENROLLMENT_STATUSES)
    .order('created_at', { ascending: true })
    .limit(300);
  if (preError) throw preError;

  const reserved = (preEnrollments || [])
    .filter((item) => !excludedPre || String(item.id) !== String(excludedPre))
    .map((item) => ({ item, player: item.jugador_payload || {} }))
    .filter(({ player }) => String(player.rama_id || '') === String(branch.id))
    .filter(({ player }) => {
      if (!category) return true;
      // Una pre-matrícula antigua sin categoría se trata como reserva de rama
      // para no prometer el mismo dorsal a dos familias mientras se regulariza.
      return !player.categoria_id || String(player.categoria_id) === String(category.id);
    })
    .filter(({ player }) => player.numero_camiseta != null && player.numero_camiseta !== '')
    .map(({ item, player }) => ({ id: item.id, nombre: player.nombre || 'Pre-matrícula', numero: player.numero_camiseta }));

  return {
    ...buildJerseyMap({ assigned, reserved }),
    scope: {
      rama: { id: branch.id, nombre: branch.nombre, disciplina: branch.disciplina },
      categoria: category ? { id: category.id, nombre: category.nombre } : null,
    },
  };
};

const assertJerseyNumberAvailable = async ({
  academyId,
  branchId,
  categoryId = null,
  number,
  excludePrematriculaId = null,
  excludePlayerId = null,
} = {}) => {
  const normalized = normalizeJerseyNumber(number);
  if (normalized == null) return null;
  const map = await listJerseyNumbers({
    academyId,
    branchId,
    categoryId,
    excludePrematriculaId,
    excludePlayerId,
  });
  const item = map.numbers.find((entry) => entry.number === normalized);
  if (!item || item.status === 'available') return normalized;

  const error = new Error(item.status === 'reserved'
    ? `El dorsal ${normalized} ya está reservado por otra pre-matrícula. Elige otro número.`
    : `El dorsal ${normalized} ya está ocupado en este alcance. Elige otro número.`);
  error.status = 409;
  error.code = item.status === 'reserved' ? 'JERSEY_NUMBER_RESERVED' : 'JERSEY_NUMBER_OCCUPIED';
  error.jersey = item;
  throw error;
};

const assignJerseyNumber = async ({ academyId, playerId, branchId, categoryId = null, number }) => {
  const cleanPlayerId = safeText(playerId, 80);
  const cleanBranchId = safeText(branchId, 80);
  const cleanCategoryId = safeText(categoryId, 80) || null;
  if (!cleanPlayerId) {
    const error = new Error('Selecciona un alumno.');
    error.status = 400;
    error.code = 'PLAYER_REQUIRED';
    throw error;
  }

  await resolveJerseyScope({ academyId, branchId: cleanBranchId, categoryId: cleanCategoryId });
  await getStudentEnrollment(academyId, cleanPlayerId, {
    branchId: cleanBranchId,
    categoryId: cleanCategoryId || undefined,
  });

  const normalized = normalizeJerseyNumber(number);
  if (normalized != null) {
    await assertJerseyNumberAvailable({
      academyId,
      branchId: cleanBranchId,
      categoryId: cleanCategoryId,
      number: normalized,
      excludePlayerId: cleanPlayerId,
    });
  }

  const { data, error } = await supabase.from('jugadores')
    .update({ numero_camiseta: normalized })
    .eq('id', cleanPlayerId)
    .eq('academia_id', academyId)
    .select('id,nombre,numero_camiseta')
    .single();
  if (error) throw error;
  return data;
};

module.exports = {
  MIN_JERSEY_NUMBER,
  MAX_JERSEY_NUMBER,
  normalizeJerseyNumber,
  buildJerseyMap,
  listJerseyNumbers,
  assertJerseyNumberAvailable,
  assignJerseyNumber,
};
