const supabase = require('../config/supabase');
const { todayInChile, recalculateFinancialStatus } = require('./monthlyBilling');

const moneyValue = (value) => Math.max(0, Number(value) || 0);
const currentPeriod = () => `${todayInChile().slice(0, 7)}-01`;

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

const createSportEnrollment = async ({ academiaId, userId, jugadorId, sedeId, ramaId, categoriaId = null, montoMatricula = 0, abonoMatricula = 0, montoMensualidad = 0 }) => {
  let enrollment = null;
  const createdChargeIds = [];
  try {
    const context = await loadEnrollmentContext({ academiaId, jugadorId, sedeId, ramaId, categoriaId });
    const { data: existing, error: existingError } = await supabase.from('inscripciones_deportivas')
      .select('id').eq('academia_id', academiaId).eq('jugador_id', jugadorId).eq('rama_id', ramaId).eq('estado', 'Activa').maybeSingle();
    if (existingError) throw existingError;
    if (existing) throw Object.assign(new Error(`${context.player.nombre} ya tiene una inscripción activa en ${context.branch.disciplina}.`), { statusCode: 409, code: 'SPORT_ENROLLMENT_EXISTS' });

    const matricula = moneyValue(montoMatricula);
    const mensualidad = moneyValue(montoMensualidad);
    const abono = Math.min(moneyValue(abonoMatricula), matricula);
    const { count, error: countError } = await supabase.from('inscripciones_deportivas').select('id', { count: 'exact', head: true })
      .eq('academia_id', academiaId).eq('jugador_id', jugadorId).eq('estado', 'Activa');
    if (countError) throw countError;

    const { data: created, error: enrollmentError } = await supabase.from('inscripciones_deportivas').insert({
      academia_id: academiaId, jugador_id: jugadorId, sede_id: sedeId, rama_id: ramaId, categoria_id: categoriaId,
      estado: 'Activa', fecha_inicio: todayInChile(), monto_matricula: matricula, monto_mensualidad: mensualidad,
      es_principal: Number(count || 0) === 0,
    }).select('*').single();
    if (enrollmentError) {
      if (enrollmentError.code === '23505') throw Object.assign(new Error('El alumno ya está inscrito en esa rama deportiva.'), { statusCode: 409, code: 'SPORT_ENROLLMENT_EXISTS' });
      throw enrollmentError;
    }
    enrollment = created;

    if (categoriaId) {
      const { error } = await supabase.from('jugador_categoria').upsert([{ jugador_id: jugadorId, categoria_id: categoriaId }], { onConflict: 'jugador_id,categoria_id', ignoreDuplicates: true });
      if (error) throw error;
    }

    if (matricula > 0) {
      const { data: charge, error } = await supabase.from('cobros').insert({
        academia_id: academiaId, inscripcion_id: enrollment.id, sede_id: sedeId, rama_id: ramaId, jugador_id: jugadorId,
        concepto: `Matrícula ${context.branch.disciplina}${context.category?.nombre ? ` · ${context.category.nombre}` : ''}`,
        tipo_concepto: 'Matrícula', monto: matricula, monto_pagado: 0, estado: 'Pendiente', fecha_vencimiento: todayInChile(),
      }).select('id').single();
      if (error) throw error;
      createdChargeIds.push(charge.id);
      if (abono > 0) {
        const { error: paymentError } = await supabase.rpc('registrar_pago_cobro', {
          p_academia_id: academiaId, p_cobro_id: charge.id, p_monto: abono, p_metodo_pago: 'Sin registrar',
          p_observaciones: `Abono al inscribir en ${context.branch.disciplina}`,
          p_idempotency_key: `inscripcion-${enrollment.id}-abono`, p_usuario_id: userId || null,
        });
        if (paymentError) throw paymentError;
      }
    }

    if (mensualidad > 0) {
      const { data: charge, error } = await supabase.from('cobros').insert({
        academia_id: academiaId, inscripcion_id: enrollment.id, sede_id: sedeId, rama_id: ramaId, jugador_id: jugadorId,
        concepto: `Mensualidad Inicial · ${context.branch.disciplina}`, tipo_concepto: 'Mensualidad', monto: mensualidad,
        monto_pagado: 0, estado: 'Pendiente', fecha_vencimiento: todayInChile(), periodo_mensualidad: currentPeriod(),
      }).select('id').single();
      if (error) throw error;
      createdChargeIds.push(charge.id);
    }

    await recalculateFinancialStatus(academiaId);
    return { ...enrollment, jugador: context.player, sede: context.site, rama: context.branch, categoria: context.category, cobros_creados: createdChargeIds.length };
  } catch (error) {
    if (createdChargeIds.length) await supabase.from('cobros').delete().in('id', createdChargeIds);
    if (enrollment?.id) await supabase.from('inscripciones_deportivas').delete().eq('id', enrollment.id);
    throw error;
  }
};

module.exports = { createSportEnrollment, loadEnrollmentContext, moneyValue };
