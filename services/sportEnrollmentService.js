const supabase = require('../config/supabase');
const { recalculateFinancialStatus } = require('./monthlyBilling');

const moneyValue = (value) => Math.max(0, Number(value) || 0);

const loadEnrollmentContext = async ({ academiaId, jugadorId, sedeId, ramaId, categoriaId }) => {
  const [playerResult, siteResult, branchResult, categoryResult] = await Promise.all([
    supabase.from('jugadores').select('id,nombre,rut,tutor_id,sede_id,rama_id').eq('id', jugadorId).eq('academia_id', academiaId).maybeSingle(),
    supabase.from('sedes').select('id,nombre,activa').eq('id', sedeId).eq('academia_id', academiaId).maybeSingle(),
    supabase.from('ramas').select('id,nombre,disciplina,sede_id,activa').eq('id', ramaId).eq('academia_id', academiaId).maybeSingle(),
    categoriaId ? supabase.from('categorias').select('id,nombre,sede_id,rama_id').eq('id', categoriaId).eq('academia_id', academiaId).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  for (const result of [playerResult, siteResult, branchResult, categoryResult]) if (result?.error) throw result.error;
  if (!playerResult.data) throw Object.assign(new Error('El alumno no pertenece a esta academia.'), { statusCode: 404, code: 'SPORT_PLAYER_NOT_FOUND' });
  if (!siteResult.data || siteResult.data.activa === false) throw Object.assign(new Error('La sede seleccionada no está disponible.'), { statusCode: 400, code: 'SPORT_SITE_NOT_AVAILABLE' });
  if (!branchResult.data || branchResult.data.activa === false) throw Object.assign(new Error('La rama deportiva seleccionada no está disponible.'), { statusCode: 400, code: 'SPORT_BRANCH_NOT_AVAILABLE' });
  if (branchResult.data.sede_id !== sedeId) throw Object.assign(new Error('La rama deportiva no pertenece a la sede seleccionada.'), { statusCode: 400, code: 'SPORT_BRANCH_NOT_AVAILABLE' });
  if (categoriaId && (!categoryResult.data || categoryResult.data.rama_id !== ramaId || categoryResult.data.sede_id !== sedeId)) throw Object.assign(new Error('La categoría seleccionada no pertenece a esa sede y rama deportiva.'), { statusCode: 400, code: 'SPORT_CATEGORY_SCOPE_MISMATCH' });
  return { player: playerResult.data, site: siteResult.data, branch: branchResult.data, category: categoryResult.data };
};

const mapEnrollmentRpcError = (error, playerName, branchName) => {
  const detail = [error?.message, error?.details, error?.hint].filter(Boolean).join(' ').toUpperCase();
  const mapped = new Error(error?.message || 'No fue posible crear la inscripción deportiva.');
  mapped.cause = error;

  if (detail.includes('IDEMPOTENCY_KEY_REUSED')) {
    mapped.statusCode = 409;
    mapped.code = 'IDEMPOTENCY_KEY_REUSED';
    mapped.message = 'La misma clave de operación ya fue usada con datos diferentes.';
    return mapped;
  }
  if (detail.includes('SPORT_ENROLLMENT_EXISTS')) {
    mapped.statusCode = 409;
    mapped.code = 'SPORT_ENROLLMENT_EXISTS';
    mapped.message = `${playerName || 'El alumno'} ya tiene una inscripción activa en ${branchName || 'esa rama deportiva'}.`;
    return mapped;
  }
  if (detail.includes('SPORT_REQUEST_RESOLVED')) {
    mapped.statusCode = 409;
    mapped.code = 'SPORT_REQUEST_RESOLVED';
    mapped.message = 'La solicitud deportiva ya fue resuelta.';
    return mapped;
  }
  if (detail.includes('SPORT_REQUEST_NOT_FOUND')) {
    mapped.statusCode = 404;
    mapped.code = 'SPORT_REQUEST_NOT_FOUND';
    mapped.message = 'La solicitud deportiva no existe para esta academia.';
    return mapped;
  }
  if (detail.includes('SPORT_REQUEST_SCOPE_MISMATCH')) {
    mapped.statusCode = 409;
    mapped.code = 'SPORT_REQUEST_SCOPE_MISMATCH';
    mapped.message = 'La solicitud no coincide con el alumno, sede o rama seleccionada.';
    return mapped;
  }
  if (detail.includes('SPORT_PLAYER_NOT_FOUND')) {
    mapped.statusCode = 404;
    mapped.code = 'SPORT_PLAYER_NOT_FOUND';
    mapped.message = 'El alumno no pertenece a esta academia.';
    return mapped;
  }
  if (detail.includes('SPORT_SITE_NOT_AVAILABLE') || detail.includes('SPORT_BRANCH_NOT_AVAILABLE') || detail.includes('SPORT_CATEGORY_SCOPE_MISMATCH')) {
    mapped.statusCode = 400;
    mapped.code = 'SPORT_ENROLLMENT_INVALID_SCOPE';
    mapped.message = 'La sede, rama o categoría seleccionada ya no está disponible.';
    return mapped;
  }

  mapped.statusCode = 500;
  return mapped;
};

const createSportEnrollment = async ({
  academiaId,
  userId,
  jugadorId,
  sedeId,
  ramaId,
  categoriaId = null,
  montoMatricula = 0,
  abonoMatricula = 0,
  montoMensualidad = 0,
  idempotencyKey = null,
  requestId = null,
  response = null,
}) => {
  const context = await loadEnrollmentContext({ academiaId, jugadorId, sedeId, ramaId, categoriaId });
  const matricula = moneyValue(montoMatricula);
  const mensualidad = moneyValue(montoMensualidad);
  const abono = Math.min(moneyValue(abonoMatricula), matricula);

  const { data, error } = await supabase.rpc('create_sport_enrollment_v2', {
    p_academia_id: academiaId,
    p_usuario_id: userId || null,
    p_jugador_id: jugadorId,
    p_sede_id: sedeId,
    p_rama_id: ramaId,
    p_categoria_id: categoriaId || null,
    p_monto_matricula: matricula,
    p_abono_matricula: abono,
    p_monto_mensualidad: mensualidad,
    p_idempotency_key: idempotencyKey || null,
    p_solicitud_id: requestId || null,
    p_respuesta: response || null,
  });

  if (error) throw mapEnrollmentRpcError(error, context.player.nombre, context.branch.disciplina || context.branch.nombre);

  try {
    await recalculateFinancialStatus(academiaId);
  } catch (recalcError) {
    console.warn('Inscripción creada, pero no fue posible recalcular el resumen financiero:', recalcError?.message || recalcError);
  }

  const enrollment = data?.enrollment || {};
  const chargeIds = Array.isArray(data?.charge_ids) ? data.charge_ids : [];
  return {
    ...enrollment,
    jugador: context.player,
    sede: context.site,
    rama: context.branch,
    categoria: context.category,
    cobros_creados: chargeIds.length,
    cobro_ids: chargeIds,
    idempotent: data?.idempotent === true,
  };
};

module.exports = { createSportEnrollment, loadEnrollmentContext, moneyValue };
