const supabase = require('../config/supabase');
const { resolveIdempotencyKey } = require('./idempotency');

const clean = (value, max = 180) => String(value ?? '').trim().slice(0, max);
const money = (value) => Math.max(0, Number(value) || 0);

const translateUniformError = (error) => {
  const detail = [error?.message, error?.details, error?.hint].filter(Boolean).join(' ');
  const code = [
    'UNIFORM_IDEMPOTENCY_KEY_REQUIRED',
    'UNIFORM_INVALID_SCOPE',
    'UNIFORM_ENROLLMENT_SCOPE_MISMATCH',
    'UNIFORM_GARMENT_NOT_FOUND',
    'UNIFORM_GARMENT_BRANCH_MISMATCH',
    'UNIFORM_OUT_OF_STOCK',
    'UNIFORM_NAME_REQUIRED',
  ].find((candidate) => detail.includes(candidate));
  if (!code) return error;

  const status = code === 'UNIFORM_GARMENT_NOT_FOUND' ? 404 : code === 'UNIFORM_OUT_OF_STOCK' || code === 'UNIFORM_GARMENT_BRANCH_MISMATCH' || code === 'UNIFORM_ENROLLMENT_SCOPE_MISMATCH' ? 409 : 400;
  const messages = {
    UNIFORM_IDEMPOTENCY_KEY_REQUIRED: 'No fue posible identificar de forma segura esta operación.',
    UNIFORM_INVALID_SCOPE: 'El pedido no tiene un contexto deportivo válido.',
    UNIFORM_ENROLLMENT_SCOPE_MISMATCH: 'La inscripción del alumno no corresponde a la sede o rama seleccionada.',
    UNIFORM_GARMENT_NOT_FOUND: 'La prenda seleccionada no existe.',
    UNIFORM_GARMENT_BRANCH_MISMATCH: 'La prenda seleccionada pertenece a otra rama.',
    UNIFORM_OUT_OF_STOCK: 'No queda stock disponible de esta prenda.',
    UNIFORM_NAME_REQUIRED: 'El nombre de la prenda es obligatorio.',
  };
  return Object.assign(new Error(messages[code]), { status, code });
};

const createUniformOrder = async ({
  academyId,
  userId,
  enrollment,
  garment = null,
  garmentId = null,
  garmentName,
  size,
  jerseyNumber = null,
  printedName = null,
  amount = 0,
  generateCharge = false,
  paymentStatus = 'Pendiente de Pago',
  idempotencyKey,
}) => {
  const resolvedKey = resolveIdempotencyKey({
    providedKey: idempotencyKey,
    namespace: 'uniform-order',
    windowMs: 5 * 60 * 1000,
    payload: {
      academyId,
      playerId: enrollment?.jugador_id,
      enrollmentId: enrollment?.id,
      branchId: enrollment?.rama_id,
      garmentId: garmentId || garment?.id || null,
      garmentName: clean(garmentName || garment?.nombre),
      size: clean(size, 30) || 'S/T',
      jerseyNumber: jerseyNumber == null || jerseyNumber === '' ? null : Number(jerseyNumber),
      printedName: clean(printedName, 80),
      amount: money(amount),
      generateCharge: generateCharge === true,
      paymentStatus: clean(paymentStatus, 60) || 'Pendiente de Pago',
    },
  });

  const { data, error } = await supabase.rpc('create_uniform_order_v1', {
    p_academia_id: academyId,
    p_usuario_id: userId || null,
    p_jugador_id: enrollment.jugador_id,
    p_inscripcion_id: enrollment.id,
    p_sede_id: enrollment.sede_id,
    p_rama_id: enrollment.rama_id,
    p_prenda_id: garmentId || garment?.id || null,
    p_prenda_nombre: clean(garmentName || garment?.nombre) || null,
    p_talla: clean(size, 30) || 'S/T',
    p_numero_estampado: jerseyNumber == null || jerseyNumber === '' ? null : Number(jerseyNumber),
    p_nombre_estampado: clean(printedName, 80) || null,
    p_monto: money(amount),
    p_generar_cobro: generateCharge === true,
    p_estado_pago: clean(paymentStatus, 60) || 'Pendiente de Pago',
    p_idempotency_key: resolvedKey,
  });

  if (error) throw translateUniformError(error);
  return {
    order: data?.order || null,
    idempotent: data?.idempotent === true,
    chargeId: data?.charge_id || data?.order?.cobro_id || null,
    idempotencyKey: resolvedKey,
  };
};

module.exports = { createUniformOrder, translateUniformError };
