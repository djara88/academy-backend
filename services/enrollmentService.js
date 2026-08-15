const supabase = require('../config/supabase');

const isGuardianShirtSize = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  return !['no', 'no desea', 'no requiere', 'ninguna', 'ninguno', 'n/a', '0', 'no aplica'].includes(normalized);
};

const materializeEnrollment = async ({ academiaId, userId, payload, sourceKey }) => {
  const tutor = payload.tutor || {};
  const jugador = payload.jugador || {};
  const finanzas = payload.finanzas || {};
  const evaluacion = payload.evaluacion || {};
  const emergencia = payload.emergencia || {};

  let tutorId = null;
  if (tutor.rut) {
    const { data: existingTutor, error: lookupError } = await supabase.from('tutores')
      .select('id').eq('academia_id', academiaId).eq('rut', tutor.rut).maybeSingle();
    if (lookupError) throw lookupError;
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
    }
  }

  if (!tutorId) throw new Error('No fue posible identificar o crear al apoderado.');

  const guardianShirt = isGuardianShirtSize(jugador.talla_apoderado);
  const guardianShirtCost = guardianShirt ? (Number(jugador.monto_camiseta_apoderado) || 0) : 0;
  const matricula = Number(finanzas.monto_matricula ?? jugador.monto_matricula) || 0;
  const abono = Number(finanzas.abono_matricula ?? jugador.abono_matricula) || 0;
  const mensualidad = Number(finanzas.monto_mensualidad ?? jugador.monto_mensualidad) || 0;

  const { data: newPlayer, error: playerError } = await supabase.from('jugadores').insert([{
    academia_id: academiaId,
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
    estado_financiero: ((matricula + guardianShirtCost) > abono || mensualidad > 0) ? 'Moroso' : 'Al Día',
    alerta_medica: emergencia.nota || '',
    telefono_emergencia: emergencia.telefono || null,
    insignias: [],
  }]).select('*').single();
  if (playerError) throw playerError;

  if (evaluacion && Object.keys(evaluacion).length > 0) {
    const { error } = await supabase.from('evaluaciones').insert([{
      jugador_id: newPlayer.id,
      academia_id: academiaId,
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

  if (mensualidad > 0) {
    const { error } = await supabase.from('cobros').insert([{
      academia_id: academiaId,
      jugador_id: newPlayer.id,
      concepto: 'Mensualidad Inicial',
      tipo_concepto: 'Mensualidad',
      monto: mensualidad,
      monto_pagado: 0,
      estado: 'Pendiente',
      fecha_vencimiento: new Date().toISOString().slice(0, 10),
    }]);
    if (error) throw error;
  }

  if (jugador.talla_uniforme || jugador.numero_camiseta || jugador.nombre_camiseta) {
    await supabase.from('pedidos_indumentaria').insert([{
      academia_id: academiaId,
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
  }

  if (guardianShirt) {
    await supabase.from('pedidos_indumentaria').insert([{
      academia_id: academiaId,
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
  }

  return { jugador: newPlayer, tutorId };
};

module.exports = { materializeEnrollment };
