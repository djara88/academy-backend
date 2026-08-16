const FINAL_PRE_ENROLLMENT_STATES = new Set(['firmada', 'cancelada', 'vencida']);

const normalizeRut = (value) => String(value || '')
  .replace(/[^0-9kK]/g, '')
  .toUpperCase();

const findRutConflict = async ({ supabase, academiaId, rut, excludePrematriculaId = null }) => {
  const normalizedRut = normalizeRut(rut);
  if (!normalizedRut) return null;

  const [playersResult, preEnrollmentsResult] = await Promise.all([
    supabase.from('jugadores')
      .select('id,nombre,rut')
      .eq('academia_id', academiaId),
    supabase.from('prematriculas')
      .select('id,estado,jugador_payload,created_at')
      .eq('academia_id', academiaId),
  ]);

  if (playersResult.error) throw playersResult.error;
  if (preEnrollmentsResult.error) throw preEnrollmentsResult.error;

  const player = (playersResult.data || []).find((row) => normalizeRut(row.rut) === normalizedRut);
  if (player) {
    return {
      code: 'PLAYER_RUT_EXISTS',
      type: 'jugador',
      id: player.id,
      nombre: player.nombre || 'Alumno existente',
      message: `Ya existe un alumno matriculado con ese RUT: ${player.nombre || 'Alumno existente'}.`,
    };
  }

  const prematricula = (preEnrollmentsResult.data || []).find((row) => {
    if (excludePrematriculaId && row.id === excludePrematriculaId) return false;
    if (FINAL_PRE_ENROLLMENT_STATES.has(String(row.estado || '').toLowerCase())) return false;
    return normalizeRut(row.jugador_payload?.rut) === normalizedRut;
  });

  if (prematricula) {
    const nombre = prematricula.jugador_payload?.nombre || 'Alumno';
    return {
      code: 'PRE_ENROLLMENT_RUT_EXISTS',
      type: 'prematricula',
      id: prematricula.id,
      nombre,
      estado: prematricula.estado,
      message: `Ya existe una pre-matrícula pendiente con ese RUT para ${nombre}. Edítala o cancélala antes de crear otra.`,
    };
  }

  return null;
};

const assertRutAvailable = async (options) => {
  const conflict = await findRutConflict(options);
  if (!conflict) return;
  const error = new Error(conflict.message);
  error.code = conflict.code;
  error.conflict = conflict;
  throw error;
};

module.exports = {
  normalizeRut,
  findRutConflict,
  assertRutAvailable,
};
