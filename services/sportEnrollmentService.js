const crypto = require('crypto');
const supabase = require('../config/supabase');

const moneyValue = (value) => Math.max(0, Number(value) || 0);
const safeKey = (value) => String(value || '').trim().slice(0, 160);
const deterministicEnrollmentKey = ({ academiaId, jugadorId, sedeId, ramaId, categoriaId, montoMatricula, abonoMatricula, montoMensualidad }) => {
  const payload = [
    academiaId,
    jugadorId,
    sedeId,
    ramaId,
    categoriaId || '',
    moneyValue(montoMatricula),
    moneyValue(abonoMatricula),
    moneyValue(montoMensualidad),
  ].join('|');
  return `sport:${crypto.createHash('sha256').update(payload).digest('hex')}`;
};

const loadEnrollmentContext = async ({ academiaId, jugadorId, sedeId, ramaId, categoriaId }) => {
  const [playerResult, siteResult, branchResult, categoryResult] = await Promise.all([
    supabase.from('jugadores').select('id,nombre,rut,tutor_id,sede_id,rama_id').eq('id', jugadorId).eq('academia_id', academiaId).maybeSingle(),
    supabase.from('sedes').select('id,nombre,activa').eq('id', sedeId).eq('academia_id', academiaId).maybeSingle(),
    supabase.from('ramas').select('id,nombre,disciplina,sede_id,activa').eq('id', ramaId).eq('academia_id', academiaId).maybeSingle(),
    categoriaId ? supabase.from('categorias').select('id,nombre,sede_id,rama_id').eq('id', categoriaId).eq('academia_id', academiaId).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  for (const result of [playerResult, siteResult, branchResult, categoryResult]) if (result?.error) throw result.error;
  if (!playerResult.data) throw Object.assign(new Error('El alumno no pertenece a esta academia.'), { statusCode: 404 });
  if (!siteResult.data || siteResult.data.activa === false) throw Object.assign(new Error('La sede seleccionada no está disponible.'), { statusCode: 400 });
  if (!branchResult.data || branchResult.data.activa === false) throw Object.assign(new Error('La rama deportiva seleccionada no está disponible.'), { statusCode: 400 });
  if (branchResult.data.sede_id !== sedeId) throw Object.assign(new Error('La rama deportiva no pertenece a la sede seleccionada.'), { statusCode: 400 });
  if (categoriaId && (!categoryResult.data || categoryResult.data.rama_id !== ramaId || categoryResult.data.sede_id !== sedeId)) throw Object.assign(new Error('La categoría seleccionada no pertenece a esa sede y rama deportiva.'), { statusCode: 400 });
  return { player: playerResult.data, site: siteResult.data, branch: branchResult.data, category: categoryResult.data };
};

const translateRpcError = (error) => {
  const detail = [error?.message, error?.details, error?.hint].filter(Boolean).join(' ');
  const code = [
    'IDEMPOTENCY_KEY_REUSED',
    'SPORT_ENROLLMENT_EXISTS',
    'SPORT_REQUEST_RESOLVED',
    'SPORT_REQUEST_NOT_FOUND',
    'SPORT_REQUEST_SCOPE_MISMATCH',
    'SPORT_PLAYER_NOT_FOUND',
    'SPORT_SITE_NOT_AVAILABLE',
    'SPORT_BRANCH_NOT_AVAILABLE',
    'SPORT_CATEGORY_SCOPE_MISMATCH',
    'SPORT_ENROLLMENT_INVALID_SCOPE',
  ].find((candidate) => detail.includes(candidate));

  if (!code) return error;
  const statusCode = code.includes('NOT_FOUND') ? 404 : code.includes('EXISTS') || code.includes('RESOLVED') || code.includes('REUSED') ? 409 : 400;
  const messages = {
    IDEMPOTENCY_KEY_REUSED: 'La clave de idempotencia ya fue utilizada con datos diferentes.',
    SPORT_ENROLLMENT_EXISTS: 'El alumno ya tiene una inscripción activa en esa rama deportiva.',
    SPORT_REQUEST_RESOLVED: 'Esta solicitud ya fue resuelta.',
    SPORT_REQUEST_NOT_FOUND: 'La solicitud de inscripción no existe.',
    SPORT_REQUEST_SCOPE_MISMATCH: 'La solicitud no corresponde a la sede o rama indicada.',
    SPORT_PLAYER_NOT_FOUND: 'El alumno no pertenece a esta academia.',
    SPORT_SITE_NOT_AVAILABLE: 'La sede seleccionada no está disponible.',
    SPORT_BRANCH_NOT_AVAILABLE: 'La rama deportiva seleccionada no está disponible.',
    SPORT_CATEGORY_SCOPE_MISMATCH: 'La categoría no pertenece a esa sede y rama deportiva.',
    SPORT_ENROLLMENT_INVALID_SCOPE: 'Faltan datos obligatorios para crear la inscripción.',
  };
  return Object.assign(new Error(messages[code] || 'No fue posible crear la inscripción deportiva.'), { statusCode, code });
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
  solicitudId = null,
  respuesta = null,
}) => {
  const context = await loadEnrollmentContext({ academiaId, jugadorId, sedeId, ramaId, categoriaId });
  const resolvedKey = safeKey(idempotencyKey) || deterministicEnrollmentKey({
    academiaId, jugadorId, sedeId, ramaId, categoriaId, montoMatricula, abonoMatricula, montoMensualidad,
  });

  const { data, error } = await supabase.rpc('create_sport_enrollment_v2', {
    p_academia_id: academiaId,
    p_usuario_id: userId || null,
    p_jugador_id: jugadorId,
    p_sede_id: sedeId,
    p_rama_id: ramaId,
    p_categoria_id: categoriaId || null,
    p_monto_matricula: moneyValue(montoMatricula),
    p_abono_matricula: moneyValue(abonoMatricula),
    p_monto_mensualidad: moneyValue(montoMensualidad),
    p_idempotency_key: resolvedKey,
    p_solicitud_id: solicitudId || null,
    p_respuesta: respuesta || null,
  });

  if (error) throw translateRpcError(error);
  const enrollment = data?.enrollment || {};
  return {
    ...enrollment,
    jugador: context.player,
    sede: context.site,
    rama: context.branch,
    categoria: context.category,
    cobros_creados: Array.isArray(data?.charge_ids) ? data.charge_ids.length : 0,
    idempotent: data?.idempotent === true,
    idempotency_key: resolvedKey,
  };
};

module.exports = {
  createSportEnrollment,
  loadEnrollmentContext,
  moneyValue,
  deterministicEnrollmentKey,
};
