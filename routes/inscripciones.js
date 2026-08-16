const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { todayInChile, recalculateFinancialStatus } = require('../services/monthlyBilling');

const moneyValue = (value) => Math.max(0, Number(value) || 0);
const currentPeriod = () => `${todayInChile().slice(0, 7)}-01`;

const loadEnrollmentContext = async ({ academiaId, jugadorId, sedeId, ramaId, categoriaId }) => {
  const [playerResult, siteResult, branchResult, categoryResult] = await Promise.all([
    supabase.from('jugadores').select('id,nombre,rut,tutor_id,sede_id,rama_id').eq('id', jugadorId).eq('academia_id', academiaId).maybeSingle(),
    supabase.from('sedes').select('id,nombre,activa').eq('id', sedeId).eq('academia_id', academiaId).maybeSingle(),
    supabase.from('ramas').select('id,nombre,disciplina,sede_id,activa').eq('id', ramaId).eq('academia_id', academiaId).maybeSingle(),
    categoriaId
      ? supabase.from('categorias').select('id,nombre,sede_id,rama_id').eq('id', categoriaId).eq('academia_id', academiaId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  for (const result of [playerResult, siteResult, branchResult, categoryResult]) {
    if (result?.error) throw result.error;
  }
  if (!playerResult.data) throw Object.assign(new Error('El alumno no pertenece a esta academia.'), { statusCode: 404 });
  if (!siteResult.data || siteResult.data.activa === false) throw Object.assign(new Error('La sede seleccionada no está disponible.'), { statusCode: 400 });
  if (!branchResult.data || branchResult.data.activa === false) throw Object.assign(new Error('La rama deportiva seleccionada no está disponible.'), { statusCode: 400 });
  if (branchResult.data.sede_id !== sedeId) throw Object.assign(new Error('La rama deportiva no pertenece a la sede seleccionada.'), { statusCode: 400 });
  if (categoriaId && (!categoryResult.data || categoryResult.data.rama_id !== ramaId || categoryResult.data.sede_id !== sedeId)) {
    throw Object.assign(new Error('La categoría seleccionada no pertenece a esa sede y rama deportiva.'), { statusCode: 400 });
  }
  return { player: playerResult.data, site: siteResult.data, branch: branchResult.data, category: categoryResult.data };
};

router.get('/', authMiddleware, requireDirector, async (req, res) => {
  try {
    const { data, error } = await supabase.from('inscripciones_deportivas')
      .select(`id,jugador_id,sede_id,rama_id,categoria_id,estado,fecha_inicio,fecha_fin,monto_matricula,monto_mensualidad,es_principal,created_at,
        jugadores(id,nombre,rut,fecha_nacimiento,foto_url,avatar_url),
        sedes(id,nombre),ramas(id,nombre,disciplina),categorias(id,nombre)`)
      .eq('academia_id', req.user.academia_id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (error) {
    console.error('Error cargando inscripciones deportivas:', error?.message || error);
    return res.status(500).json({ success: false, error: 'No fue posible cargar las inscripciones deportivas.' });
  }
});

router.get('/alumnos', authMiddleware, requireDirector, async (req, res) => {
  try {
    const { data: players, error: playersError } = await supabase.from('jugadores')
      .select('id,nombre,rut,fecha_nacimiento,foto_url,avatar_url,tutor_id')
      .eq('academia_id', req.user.academia_id)
      .order('nombre');
    if (playersError) throw playersError;
    const { data: enrollments, error: enrollmentsError } = await supabase.from('inscripciones_deportivas')
      .select('id,jugador_id,sede_id,rama_id,categoria_id,estado,monto_mensualidad,ramas(nombre,disciplina),sedes(nombre),categorias(nombre)')
      .eq('academia_id', req.user.academia_id)
      .eq('estado', 'Activa');
    if (enrollmentsError) throw enrollmentsError;
    const byPlayer = new Map();
    for (const enrollment of enrollments || []) {
      const list = byPlayer.get(enrollment.jugador_id) || [];
      list.push(enrollment);
      byPlayer.set(enrollment.jugador_id, list);
    }
    return res.json({
      success: true,
      data: (players || []).map((player) => ({ ...player, inscripciones: byPlayer.get(player.id) || [] })),
    });
  } catch (error) {
    console.error('Error cargando alumnos para inscripción:', error?.message || error);
    return res.status(500).json({ success: false, error: 'No fue posible cargar los alumnos existentes.' });
  }
});

router.post('/', authMiddleware, requireDirector, async (req, res) => {
  let enrollment = null;
  const createdChargeIds = [];
  try {
    const academiaId = req.user.academia_id;
    const jugadorId = String(req.body?.jugador_id || '').trim();
    const sedeId = String(req.body?.sede_id || '').trim();
    const ramaId = String(req.body?.rama_id || '').trim();
    const categoriaId = String(req.body?.categoria_id || '').trim() || null;
    if (!jugadorId || !sedeId || !ramaId) {
      return res.status(400).json({ success: false, error: 'Selecciona alumno, sede y rama deportiva.' });
    }

    const context = await loadEnrollmentContext({ academiaId, jugadorId, sedeId, ramaId, categoriaId });
    const { data: existing, error: existingError } = await supabase.from('inscripciones_deportivas')
      .select('id,estado').eq('academia_id', academiaId).eq('jugador_id', jugadorId).eq('rama_id', ramaId).eq('estado', 'Activa').maybeSingle();
    if (existingError) throw existingError;
    if (existing) {
      return res.status(409).json({ success: false, code: 'SPORT_ENROLLMENT_EXISTS', error: `${context.player.nombre} ya tiene una inscripción activa en ${context.branch.disciplina}.` });
    }

    const matricula = moneyValue(req.body?.monto_matricula);
    const mensualidad = moneyValue(req.body?.monto_mensualidad);
    const abono = Math.min(moneyValue(req.body?.abono_matricula), matricula);
    const { count, error: countError } = await supabase.from('inscripciones_deportivas')
      .select('id', { count: 'exact', head: true }).eq('academia_id', academiaId).eq('jugador_id', jugadorId).eq('estado', 'Activa');
    if (countError) throw countError;

    const { data: created, error: enrollmentError } = await supabase.from('inscripciones_deportivas').insert([{
      academia_id: academiaId,
      jugador_id: jugadorId,
      sede_id: sedeId,
      rama_id: ramaId,
      categoria_id: categoriaId,
      estado: 'Activa',
      fecha_inicio: todayInChile(),
      monto_matricula: matricula,
      monto_mensualidad: mensualidad,
      es_principal: Number(count || 0) === 0,
    }]).select('*').single();
    if (enrollmentError) {
      if (enrollmentError.code === '23505') return res.status(409).json({ success: false, code: 'SPORT_ENROLLMENT_EXISTS', error: 'El alumno ya está inscrito en esa rama deportiva.' });
      throw enrollmentError;
    }
    enrollment = created;

    if (categoriaId) {
      const { error: categoryError } = await supabase.from('jugador_categoria').upsert(
        [{ jugador_id: jugadorId, categoria_id: categoriaId }],
        { onConflict: 'jugador_id,categoria_id', ignoreDuplicates: true }
      );
      if (categoryError) throw categoryError;
    }

    if (matricula > 0) {
      const { data: charge, error: chargeError } = await supabase.from('cobros').insert([{
        academia_id: academiaId,
        inscripcion_id: enrollment.id,
        sede_id: sedeId,
        rama_id: ramaId,
        jugador_id: jugadorId,
        concepto: `Matrícula ${context.branch.disciplina}${context.category?.nombre ? ` · ${context.category.nombre}` : ''}`,
        tipo_concepto: 'Matrícula',
        monto: matricula,
        monto_pagado: 0,
        estado: 'Pendiente',
        fecha_vencimiento: todayInChile(),
      }]).select('id').single();
      if (chargeError) throw chargeError;
      createdChargeIds.push(charge.id);
      if (abono > 0) {
        const { error: paymentError } = await supabase.rpc('registrar_pago_cobro', {
          p_academia_id: academiaId,
          p_cobro_id: charge.id,
          p_monto: abono,
          p_metodo_pago: 'Sin registrar',
          p_observaciones: `Abono al inscribir en ${context.branch.disciplina}`,
          p_idempotency_key: `inscripcion-${enrollment.id}-abono`,
          p_usuario_id: req.user.id || null,
        });
        if (paymentError) throw paymentError;
      }
    }

    if (mensualidad > 0) {
      const { data: charge, error: monthlyError } = await supabase.from('cobros').insert([{
        academia_id: academiaId,
        inscripcion_id: enrollment.id,
        sede_id: sedeId,
        rama_id: ramaId,
        jugador_id: jugadorId,
        concepto: `Mensualidad Inicial · ${context.branch.disciplina}`,
        tipo_concepto: 'Mensualidad',
        monto: mensualidad,
        monto_pagado: 0,
        estado: 'Pendiente',
        fecha_vencimiento: todayInChile(),
        periodo_mensualidad: currentPeriod(),
      }]).select('id').single();
      if (monthlyError) throw monthlyError;
      createdChargeIds.push(charge.id);
    }

    await recalculateFinancialStatus(academiaId);
    return res.status(201).json({
      success: true,
      data: {
        ...enrollment,
        jugador: context.player,
        sede: context.site,
        rama: context.branch,
        categoria: context.category,
        cobros_creados: createdChargeIds.length,
      },
    });
  } catch (error) {
    console.error('Error creando inscripción deportiva:', error?.message || error);
    if (createdChargeIds.length) await supabase.from('cobros').delete().in('id', createdChargeIds);
    if (enrollment?.id) await supabase.from('inscripciones_deportivas').delete().eq('id', enrollment.id);
    return res.status(error?.statusCode || 500).json({ success: false, error: error?.statusCode ? error.message : 'No fue posible crear la inscripción deportiva.' });
  }
});

router.patch('/:id/estado', authMiddleware, requireDirector, async (req, res) => {
  try {
    const estado = String(req.body?.estado || '').trim();
    if (!['Activa','Inactiva','Retirada'].includes(estado)) return res.status(400).json({ success: false, error: 'Estado de inscripción no válido.' });
    const { data, error } = await supabase.from('inscripciones_deportivas').update({
      estado,
      fecha_fin: estado === 'Activa' ? null : todayInChile(),
      updated_at: new Date().toISOString(),
    }).eq('id', req.params.id).eq('academia_id', req.user.academia_id).select('*').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Inscripción no encontrada.' });
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error cambiando estado de inscripción:', error?.message || error);
    return res.status(500).json({ success: false, error: 'No fue posible actualizar la inscripción.' });
  }
});

module.exports = router;
