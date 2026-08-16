const supabase = require('../config/supabase');
const { getAcademyEntitlements } = require('./planCatalog');
const { recalculateFinancialStatus } = require('./monthlyBilling');
const { normalizeRut } = require('./rutGuard');
const { resolveStructure } = require('./academyStructure');

const isGuardianShirtSize = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  return !['no', 'no desea', 'no requiere', 'ninguna', 'ninguno', 'n/a', '0', 'no aplica'].includes(normalized);
};

const cleanupMaterializedEnrollment = async ({ academiaId, jugadorId, tutorId, tutorWasCreated = false }) => {
  if (jugadorId) {
    const { error } = await supabase.from('jugadores').delete().eq('academia_id', academiaId).eq('id', jugadorId);
    if (error) console.warn('No fue posible limpiar un alumno de una matrícula fallida.');
  }
  if (tutorWasCreated && tutorId) {
    const { count } = await supabase.from('jugadores').select('id', { count: 'exact', head: true })
      .eq('academia_id', academiaId).eq('tutor_id', tutorId);
    if (!count) {
      const { error } = await supabase.from('tutores').delete().eq('academia_id', academiaId).eq('id', tutorId);
      if (error) console.warn('No fue posible limpiar un apoderado huérfano de una matrícula fallida.');
    }
  }
};

const materializeEnrollment = async ({ academiaId, userId, payload, sourceKey }) => {
  const tutor = payload.tutor || {};
  const jugador = payload.jugador || {};
  const finanzas = payload.finanzas || {};
  const evaluacion = payload.evaluacion || {};
  const emergencia = payload.emergencia || {};
  const structure = await resolveStructure({ academiaId, sedeId: jugador.sede_id || null, ramaId: jugador.rama_id || null });

  const { data: academy, error: academyError } = await supabase.from('academias').select('*').eq('id', academiaId).single();
  if (academyError || !academy) throw new Error('No fue posible validar el plan de la academia.');
  const playerLimit = getAcademyEntitlements(academy).limits.players;
  if (Number.isInteger(playerLimit)) {
    const { count, error: countError } = await supabase.from('jugadores').select('id', { count: 'exact', head: true }).eq('academia_id', academiaId);
    if (countError) throw countError;
    if (Number(count || 0) >= playerLimit) {
      const error = new Error(`El plan actual alcanzó su límite de ${playerLimit} jugadores.`);
      error.code = 'PLAYER_LIMIT_REACHED';
      throw error;
    }
  }

  if (jugador.rut) {
    const normalizedRut = normalizeRut(jugador.rut);
    const { data: existingPlayers, error: duplicateError } = await supabase.from('jugadores')
      .select('id,nombre,rut').eq('academia_id', academiaId);
    if (duplicateError) throw duplicateError;
    const duplicate = (existingPlayers || []).find((row) => normalizeRut(row.rut) === normalizedRut);
    if (duplicate) {
      const error = new Error('Ya existe un alumno con ese RUT en la academia.');
      error.code = 'PLAYER_ALREADY_EXISTS';
      throw error;
    }
  }

  let tutorId = null;
  let tutorWasCreated = false;
  let newPlayer = null;

  try {
    if (tutor.rut) {
      const normalizedTutorRut = normalizeRut(tutor.rut);
      const { data: tutors, error: lookupError } = await supabase.from('tutores')
        .select('id,rut').eq('academia_id', academiaId);
      if (lookupError) throw lookupError;
      const existingTutor = (tutors || []).find((row) => normalizeRut(row.rut) === normalizedTutorRut);
      if (existingTutor) {
        tutorId = existingTutor.id;
        const { error } = await supabase.from('tutores').update({
          nombre_completo: tutor.nombre_completo || tutor.nombre || null,
          telefono: tutor.telefono || null,
          email: tutor.email || null,
        }).eq('id', tutorId).eq('academia_id', academiaId);
        if (error) throw error;
      } else {
        const { data: createdTutor, error } = await supabase.from('tutores').insert([{
          academia_id: academiaId,
          nombre_completo: tutor.nombre_completo || tutor.nombre || null,
          rut: tutor.rut,
          telefono: tutor.telefono || null,
          email: tutor.email || null,
          parentesco: tutor.parentesco || null,
          direccion: tutor.direccion || null,
        }]).select('id').single();
        if (error) throw error;
        tutorId = createdTutor.id;
        tutorWasCreated = true;
      }
    }

    if (!tutorId) throw new Error('No fue posible identificar o crear al apoderado.');

    const guardianShirt = isGuardianShirtSize(jugador.talla_apoderado);
    const guardianShirtCost = guardianShirt ? (Number(jugador.monto_camiseta_apoderado) || 0) : 0;
    const matricula = Number(finanzas.monto_matricula ?? jugador.monto_matricula) || 0;
    const abono = Number(finanzas.abono_matricula ?? jugador.abono_matricula) || 0;
    const mensualidad = Number(finanzas.monto_mensualidad ?? jugador.monto_mensualidad) || 0;

    const { data: createdPlayer, error: playerError } = await supabase.from('jugadores').insert([{
      academia_id: academiaId,
      sede_id: structure.sede_id,
      rama_id: structure.rama_id,
      tutor_id: tutorId,
      nombre: jugador.nombre,
      rut: jugador.rut || null,
      tipo_alumno: jugador.tipo_alumno || 'Nuevo',
      certificado_medico: jugador.certificado_medico || 'Pendiente',
      sexo: jugador.sexo || null,
      fecha_nacimiento: jugador.fecha_nacimiento || null,
      posicion_cancha: jugador.posicion_cancha || null,
      talla_uniforme: jugador.talla_uniforme || null,
      talla_apoderado: guardianShirt ? String(jugador.talla_apoderado).toUpperCase() : null,
      numero_camiseta: jugador.numero_camiseta ? Number(jugador.numero_camiseta) : null,
      nombre_camiseta: jugador.nombre_camiseta || null,
      monto_matricula: matricula,
      abono_matricula: abono,
      monto_mensualidad: mensualidad,
      foto_base64: jugador.foto_base64 || null,
      estado_uniforme: 'Pendiente',
      estado_matricula: 'Activa',
      fecha_matricula: new Date().toISOString().slice(0, 10),
      estado_financiero: 'Al Día',
      alerta_medica: emergencia.nota || '',
      telefono_emergencia: emergencia.telefono || null,
      insignias: [],
    }]).select('*').single();
    if (playerError) throw playerError;
    newPlayer = createdPlayer;

    if (evaluacion && Object.keys(evaluacion).length > 0) {
      const { error } = await supabase.from('evaluaciones').insert([{
        jugador_id: newPlayer.id,
        academia_id: academiaId,
        sede_id: structure.sede_id,
        rama_id: structure.rama_id,
        datos_radar: evaluacion,
        comentarios_profesor: 'Evaluación inicial registrada durante la pre-matrícula.',
      }]);
      if (error) throw error;
    }

    const totalMatricula = matricula + guardianShirtCost;
    if (totalMatricula > 0) {
      const concepto = guardianShirtCost > 0
        ? `Matrícula Inicial (Incluye Camiseta Apoderado Talla ${String(jugador.talla_apoderado).toUpperCase()})`
        : 'Matrícula Inicial';
      const { data: charge, error: chargeError } = await supabase.from('cobros').insert([{
        academia_id: academiaId,
        sede_id: structure.sede_id,
        rama_id: structure.rama_id,
        jugador_id: newPlayer.id,
        concepto,
        tipo_concepto: 'Matrícula',
        monto: totalMatricula,
        monto_pagado: 0,
        estado: 'Pendiente',
        fecha_vencimiento: new Date().toISOString().slice(0, 10),
      }]).select('id').single();
      if (chargeError) throw chargeError;

      if (abono > 0) {
        const { error: paymentError } = await supabase.rpc('registrar_pago_cobro', {
          p_academia_id: academiaId,
          p_cobro_id: charge.id,
          p_monto: Math.min(abono, totalMatricula),
          p_metodo_pago: 'Sin registrar',
          p_observaciones: 'Abono registrado al formalizar pre-matrícula',
          p_idempotency_key: `${sourceKey || 'prematricula'}-${newPlayer.id}-abono`,
          p_usuario_id: userId || null,
        });
        if (paymentError) throw paymentError;
      }
    }

    // La mensualidad no se genera el día de la matrícula. El calendario mensual
    // de la academia crea el primer cobro a partir del ciclo siguiente.

    if (jugador.talla_uniforme || jugador.numero_camiseta || jugador.nombre_camiseta) {
      const { error } = await supabase.from('pedidos_indumentaria').insert([{
        academia_id: academiaId,
        sede_id: structure.sede_id,
        rama_id: structure.rama_id,
        jugador_id: newPlayer.id,
        prenda_id: null,
        prenda_nombre: 'Kit de Matrícula (Alumno)',
        talla: jugador.talla_uniforme || 'S/T',
        numero_estampado: jugador.numero_camiseta ? Number(jugador.numero_camiseta) : null,
        nombre_estampado: jugador.nombre_camiseta || '',
        monto: 0,
        estado_pago: 'Incluido en Matrícula',
        estado_entrega: 'Pendiente',
      }]);
      if (error) throw error;
    }

    if (guardianShirt) {
      const { error } = await supabase.from('pedidos_indumentaria').insert([{
        academia_id: academiaId,
        sede_id: structure.sede_id,
        rama_id: structure.rama_id,
        jugador_id: newPlayer.id,
        prenda_id: null,
        prenda_nombre: 'Camiseta Apoderado',
        talla: String(jugador.talla_apoderado).toUpperCase(),
        numero_estampado: null,
        nombre_estampado: '',
        monto: guardianShirtCost,
        estado_pago: 'Incluido en Matrícula',
        estado_entrega: 'Pendiente',
      }]);
      if (error) throw error;
    }

    await recalculateFinancialStatus(academiaId);
    return { jugador: newPlayer, tutorId, tutorWasCreated };
  } catch (error) {
    await cleanupMaterializedEnrollment({
      academiaId,
      jugadorId: newPlayer?.id || null,
      tutorId,
      tutorWasCreated,
    });
    throw error;
  }
};

module.exports = { materializeEnrollment, cleanupMaterializedEnrollment };
