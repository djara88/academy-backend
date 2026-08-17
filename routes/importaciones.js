const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { getAcademyEntitlements } = require('../services/planCatalog');
const { getBranch, listAcademyBranches } = require('../services/branchContext');

const text = (value, max = 250) => String(value ?? '').trim().slice(0, max);
const normalizeDocument = (value) => text(value, 60).replace(/\s/g, '').toUpperCase();
const documentKey = (value) => normalizeDocument(value).replace(/[^A-Z0-9]/g, '');
const nameKey = (value) => text(value, 180).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const today = () => new Date().toISOString().slice(0, 10);
const numeric = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const raw = String(value ?? '').replace(/[$\s]/g, '').trim();
  if (!raw) return 0;
  let normalized = raw;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(raw)) normalized = raw.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw)) normalized = raw.replace(/,/g, '');
  else if (raw.includes(',')) normalized = raw.replace(/\./g, '').replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};
const dateOrNull = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
const normalizeRow = (raw = {}, index = 0) => ({
  fila: index + 2,
  nombre_alumno: text(raw.nombre_alumno, 180),
  rut_alumno: normalizeDocument(raw.rut_alumno),
  fecha_nacimiento: dateOrNull(raw.fecha_nacimiento),
  sexo: text(raw.sexo, 40),
  posicion: text(raw.posicion, 100),
  categoria: text(raw.categoria, 120),
  nombre_apoderado: text(raw.nombre_apoderado, 180),
  rut_apoderado: normalizeDocument(raw.rut_apoderado),
  telefono_apoderado: text(raw.telefono_apoderado, 80),
  email_apoderado: text(raw.email_apoderado, 240).toLowerCase(),
  monto_matricula: Math.max(0, numeric(raw.monto_matricula)),
  mensualidad: Math.max(0, numeric(raw.mensualidad)),
  saldo_pendiente: Math.max(0, numeric(raw.saldo_pendiente)),
  talla_uniforme: text(raw.talla_uniforme, 40),
  numero_camiseta: raw.numero_camiseta === '' || raw.numero_camiseta == null ? null : Number(raw.numero_camiseta),
  estado: text(raw.estado, 40) || 'Activo',
});
const enrollmentStatus = (value) => {
  const key = nameKey(value);
  if (key.includes('retir')) return 'Retirada';
  if (key.includes('inactiv')) return 'Inactiva';
  return 'Activa';
};
const playerDocKey = (player) => documentKey(player.rut || player.numero_documento || player.dni || player.pasaporte || player.rut_pasaporte);

const getCapacity = async (academiaId) => {
  const [academyResult, countResult] = await Promise.all([
    supabase.from('academias').select('*').eq('id', academiaId).single(),
    supabase.from('jugadores').select('id', { count: 'exact', head: true }).eq('academia_id', academiaId),
  ]);
  if (academyResult.error || countResult.error) throw academyResult.error || countResult.error;
  const limit = getAcademyEntitlements(academyResult.data || {}).limits.players;
  const current = Number(countResult.count || 0);
  return { limit, current, remaining: Number.isInteger(limit) ? Math.max(0, limit - current) : null };
};

const resolveScope = async (academiaId, ramaId) => {
  const branch = await getBranch(academiaId, ramaId);
  if (!branch?.sede_id) {
    const error = new Error('La rama seleccionada no tiene una sede válida.');
    error.status = 409;
    error.code = 'BRANCH_SITE_REQUIRED';
    throw error;
  }
  return { branch, rama_id: branch.id, sede_id: branch.sede_id };
};

const loadExisting = async (academiaId, ramaId) => {
  const [{ data: players, error: playerError }, { data: enrollments, error: enrollmentError }] = await Promise.all([
    supabase.from('jugadores').select('id,nombre,rut,rut_pasaporte,dni,pasaporte,numero_documento,tutor_id').eq('academia_id', academiaId),
    supabase.from('inscripciones_deportivas').select('jugador_id').eq('academia_id', academiaId).eq('rama_id', ramaId).eq('estado', 'Activa'),
  ]);
  if (playerError || enrollmentError) throw playerError || enrollmentError;
  const byDocument = new Map();
  for (const player of players || []) {
    const key = playerDocKey(player);
    if (key && !byDocument.has(key)) byDocument.set(key, player);
  }
  return { byDocument, activeInBranch: new Set((enrollments || []).map((row) => String(row.jugador_id))) };
};

const validateRows = async (academiaId, ramaId, rows) => {
  const normalized = rows.map(normalizeRow);
  const { byDocument, activeInBranch } = await loadExisting(academiaId, ramaId);
  const seen = new Set();
  return normalized.map((row) => {
    const errors = [];
    const warnings = [];
    const key = documentKey(row.rut_alumno);
    const existing = key ? byDocument.get(key) || null : null;
    if (!row.nombre_alumno) errors.push('Falta nombre del alumno');
    if (!row.nombre_apoderado && !existing) warnings.push('Sin nombre de apoderado');
    if (!row.rut_apoderado && !existing) warnings.push('Sin documento de apoderado');
    if (row.email_apoderado && !/^\S+@\S+\.\S+$/.test(row.email_apoderado)) warnings.push('Correo de apoderado parece inválido');
    if (key) {
      if (seen.has(key)) errors.push('Documento de alumno duplicado dentro del archivo');
      seen.add(key);
      if (existing && activeInBranch.has(String(existing.id))) errors.push('Alumno ya tiene una inscripción activa en esta rama');
      else if (existing) warnings.push('Alumno existente: se agregará esta rama sin duplicar su ficha personal');
    } else warnings.push('Alumno sin documento: se creará una ficha nueva y la detección de duplicados será limitada');
    if (row.numero_camiseta != null && (!Number.isFinite(row.numero_camiseta) || row.numero_camiseta < 0 || row.numero_camiseta > 999)) warnings.push('Número de camiseta fuera de rango');
    return {
      ...row,
      valido: errors.length === 0,
      errors,
      warnings,
      modo: existing ? 'inscribir_existente' : 'crear_alumno',
      jugador_existente_id: existing?.id || null,
      jugador_existente_nombre: existing?.nombre || null,
    };
  });
};

const validationSummary = (rows, capacity) => {
  const valid = rows.filter((row) => row.valido);
  const newPlayers = valid.filter((row) => row.modo === 'crear_alumno').length;
  return {
    total: rows.length,
    valid: valid.length,
    errors: rows.length - valid.length,
    warnings: rows.filter((row) => row.warnings.length).length,
    new_players: newPlayers,
    existing_players_to_enroll: valid.length - newPlayers,
    player_limit: capacity.limit,
    current_players: capacity.current,
    available_slots: capacity.remaining,
    capacity_exceeded: capacity.remaining !== null && newPlayers > capacity.remaining,
  };
};

router.get('/contexto', authMiddleware, async (req, res) => {
  try {
    const [{ data: academy, error }, branches] = await Promise.all([
      supabase.from('academias').select('rama_principal_id').eq('id', req.user.academia_id).single(),
      listAcademyBranches(req.user.academia_id),
    ]);
    if (error) throw error;
    return res.json({ success: true, data: { rama_principal_id: academy?.rama_principal_id || null, ramas: branches } });
  } catch (error) {
    console.error('Error cargando contexto de importación:', error?.message || error);
    return res.status(500).json({ success: false, error: 'No fue posible cargar las ramas de la academia.' });
  }
});

router.post('/preview', authMiddleware, async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const ramaId = text(req.body?.rama_id, 80);
    if (!ramaId) return res.status(400).json({ success: false, error: 'Selecciona la rama a la que pertenecen los alumnos.' });
    if (!rows.length) return res.status(400).json({ success: false, error: 'No se recibieron filas para validar.' });
    if (rows.length > 3000) return res.status(400).json({ success: false, error: 'El archivo supera el máximo de 3.000 filas por importación.' });
    const scope = await resolveScope(req.user.academia_id, ramaId);
    const [data, capacity] = await Promise.all([validateRows(req.user.academia_id, ramaId, rows), getCapacity(req.user.academia_id)]);
    return res.json({
      success: true,
      scope: { rama_id: ramaId, rama_nombre: scope.branch.nombre, disciplina: scope.branch.disciplina, sede_id: scope.sede_id, sede_nombre: scope.branch.sedes?.nombre || null },
      summary: validationSummary(data, capacity),
      data,
    });
  } catch (error) {
    console.error('Error previsualizando importación:', error?.message || error);
    return res.status(error?.status || 500).json({ success: false, code: error?.code, error: error?.status ? error.message : 'No fue posible validar el archivo.' });
  }
});

router.post('/commit', authMiddleware, async (req, res) => {
  const academiaId = req.user.academia_id;
  let loteId = null;
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const ramaId = text(req.body?.rama_id, 80);
    if (!ramaId) return res.status(400).json({ success: false, error: 'Selecciona la rama a la que pertenecen los alumnos.' });
    if (!rows.length || rows.length > 3000) return res.status(400).json({ success: false, error: 'La importación debe contener entre 1 y 3.000 filas.' });

    const scope = await resolveScope(academiaId, ramaId);
    const [validated, capacity] = await Promise.all([validateRows(academiaId, ramaId, rows), getCapacity(academiaId)]);
    const accepted = validated.filter((row) => row.valido);
    if (!accepted.length) return res.status(400).json({ success: false, error: 'No hay filas válidas para importar.' });
    const newPlayersRequired = accepted.filter((row) => row.modo === 'crear_alumno').length;
    if (capacity.remaining !== null && newPlayersRequired > capacity.remaining) {
      return res.status(403).json({ success: false, code: 'PLAYER_LIMIT_REACHED', error: `Tu plan permite crear ${capacity.remaining} alumno(s) más. Esta importación necesita crear ${newPlayersRequired}; los alumnos ya existentes no consumen cupos adicionales.`, available_slots: capacity.remaining, new_players: newPlayersRequired });
    }

    const { data: lote, error: loteError } = await supabase.from('import_lotes').insert([{
      academia_id: academiaId,
      sede_id: scope.sede_id,
      rama_id: ramaId,
      nombre_archivo: text(req.body?.file_name, 255) || null,
      estado: 'procesando',
      total_filas: validated.length,
      created_by: req.user.id || null,
      resumen: { rama: scope.branch.nombre, disciplina: scope.branch.disciplina, sede: scope.branch.sedes?.nombre || null },
    }]).select('id').single();
    if (loteError) throw loteError;
    loteId = lote.id;

    const [{ data: categories, error: catError }, { data: tutors, error: tutorError }, { data: activeEnrollments, error: activeError }] = await Promise.all([
      supabase.from('categorias').select('id,nombre').eq('academia_id', academiaId).eq('sede_id', scope.sede_id).eq('rama_id', ramaId),
      supabase.from('tutores').select('id,rut,email,nombre_completo,telefono').eq('academia_id', academiaId),
      supabase.from('inscripciones_deportivas').select('jugador_id').eq('academia_id', academiaId).eq('estado', 'Activa'),
    ]);
    if (catError || tutorError || activeError) throw catError || tutorError || activeError;
    const categoryCache = new Map((categories || []).map((item) => [nameKey(item.nombre), item.id]));
    const tutorCache = new Map();
    for (const tutor of tutors || []) {
      const doc = documentKey(tutor.rut);
      if (doc) tutorCache.set(`doc:${doc}`, tutor.id);
      if (tutor.email) tutorCache.set(`mail:${String(tutor.email).toLowerCase()}`, tutor.id);
      if (tutor.nombre_completo) tutorCache.set(`name:${nameKey(tutor.nombre_completo)}|${text(tutor.telefono, 80)}`, tutor.id);
    }
    const hasActiveEnrollment = new Set((activeEnrollments || []).map((row) => String(row.jugador_id)));

    const record = async (row, entidad, id, detalle = {}) => {
      const { error } = await supabase.from('import_lote_items').insert([{ lote_id: loteId, academia_id: academiaId, fila: row.fila, entidad, entidad_id: id, accion: 'creado', detalle }]);
      if (error) throw error;
    };
    const createCategory = async (row) => {
      if (!row.categoria) return { id: null, created: false };
      const key = nameKey(row.categoria);
      if (categoryCache.has(key)) return { id: categoryCache.get(key), created: false };
      const { data, error } = await supabase.from('categorias').insert([{ academia_id: academiaId, sede_id: scope.sede_id, rama_id: ramaId, nombre: row.categoria }]).select('id').single();
      if (error) throw error;
      categoryCache.set(key, data.id);
      try { await record(row, 'categoria', data.id, { nombre: row.categoria, rama_id: ramaId, sede_id: scope.sede_id }); }
      catch (error) { categoryCache.delete(key); await supabase.from('categorias').delete().eq('id', data.id).eq('academia_id', academiaId); throw error; }
      return { id: data.id, created: true };
    };
    const createTutor = async (row) => {
      if (!row.nombre_apoderado) return { id: null, created: false };
      const keys = [documentKey(row.rut_apoderado) ? `doc:${documentKey(row.rut_apoderado)}` : null, row.email_apoderado ? `mail:${row.email_apoderado}` : null, `name:${nameKey(row.nombre_apoderado)}|${row.telefono_apoderado}`].filter(Boolean);
      const existing = keys.map((key) => tutorCache.get(key)).find(Boolean);
      if (existing) return { id: existing, created: false };
      const { data, error } = await supabase.from('tutores').insert([{ academia_id: academiaId, nombre_completo: row.nombre_apoderado, rut: row.rut_apoderado || null, telefono: row.telefono_apoderado || null, email: row.email_apoderado || null }]).select('id').single();
      if (error) throw error;
      keys.forEach((key) => tutorCache.set(key, data.id));
      try { await record(row, 'tutor', data.id, { nombre: row.nombre_apoderado }); }
      catch (error) { keys.forEach((key) => tutorCache.delete(key)); await supabase.from('tutores').delete().eq('id', data.id).eq('academia_id', academiaId); throw error; }
      return { id: data.id, created: true };
    };

    let imported = 0;
    let createdPlayers = 0;
    let enrolledExisting = 0;
    let failed = 0;
    const skipped = validated.length - accepted.length;
    const rowErrors = [];

    for (const row of accepted) {
      const made = { category: null, tutor: null, player: null, enrollment: null, link: null, charge: null };
      try {
        const category = await createCategory(row);
        made.category = category.created ? category.id : null;
        let playerId = row.jugador_existente_id || null;
        if (!playerId) {
          const tutor = await createTutor(row);
          made.tutor = tutor.created ? tutor.id : null;
          const { data: player, error } = await supabase.from('jugadores').insert([{
            academia_id: academiaId, sede_id: scope.sede_id, rama_id: ramaId, tutor_id: tutor.id, categoria_id: category.id,
            nombre: row.nombre_alumno, rut: row.rut_alumno || null, fecha_nacimiento: row.fecha_nacimiento, sexo: row.sexo || null,
            posicion_cancha: row.posicion || null, tipo_alumno: 'Antiguo', estado: row.estado, estado_matricula: 'Migrado',
            monto_matricula: row.monto_matricula, monto_mensualidad: row.mensualidad, talla_uniforme: row.talla_uniforme || null,
            numero_camiseta: Number.isFinite(row.numero_camiseta) ? row.numero_camiseta : null, saldo_pendiente: row.saldo_pendiente,
            estado_financiero: row.saldo_pendiente > 0 ? 'Moroso' : 'Al Día',
          }]).select('id').single();
          if (error) throw error;
          playerId = player.id;
          made.player = player.id;
          await record(row, 'jugador', player.id, { nombre: row.nombre_alumno, rama_id: ramaId, sede_id: scope.sede_id });
        }

        const status = enrollmentStatus(row.estado);
        const { data: enrollment, error: enrollmentError } = await supabase.from('inscripciones_deportivas').insert([{
          academia_id: academiaId, jugador_id: playerId, sede_id: scope.sede_id, rama_id: ramaId, categoria_id: category.id,
          estado: status, fecha_inicio: today(), monto_matricula: row.monto_matricula, monto_mensualidad: row.mensualidad,
          es_principal: made.player ? true : !hasActiveEnrollment.has(String(playerId)), rol_especialidad: row.posicion || null,
        }]).select('id').single();
        if (enrollmentError) throw enrollmentError;
        made.enrollment = enrollment.id;
        await record(row, 'inscripcion', enrollment.id, { jugador_id: playerId, rama_id: ramaId, sede_id: scope.sede_id, categoria_id: category.id, estado: status, alumno_existente: !made.player });

        if (category.id) {
          const { data: existingLink, error: lookupError } = await supabase.from('jugador_categoria').select('id').eq('jugador_id', playerId).eq('categoria_id', category.id).maybeSingle();
          if (lookupError) throw lookupError;
          if (!existingLink) {
            const { data: link, error: linkError } = await supabase.from('jugador_categoria').insert([{ jugador_id: playerId, categoria_id: category.id }]).select('id').single();
            if (linkError) throw linkError;
            made.link = link.id;
            await record(row, 'jugador_categoria', link.id, { jugador_id: playerId, categoria_id: category.id });
          }
        }

        if (row.saldo_pendiente > 0) {
          const { data: charge, error: chargeError } = await supabase.from('cobros').insert([{
            academia_id: academiaId, jugador_id: playerId, inscripcion_id: enrollment.id, sede_id: scope.sede_id, rama_id: ramaId,
            concepto: 'Saldo inicial migrado', tipo_concepto: 'Migración', monto: row.saldo_pendiente, monto_pagado: 0,
            estado: 'Pendiente', fecha_vencimiento: today(), observaciones: `Importado en ${scope.branch.nombre}`,
          }]).select('id').single();
          if (chargeError) throw chargeError;
          made.charge = charge.id;
          await record(row, 'cobro', charge.id, { concepto: 'Saldo inicial migrado', inscripcion_id: enrollment.id, rama_id: ramaId });
        }

        imported += 1;
        if (made.player) createdPlayers += 1; else enrolledExisting += 1;
        if (status === 'Activa') hasActiveEnrollment.add(String(playerId));
      } catch (rowError) {
        if (made.charge) await supabase.from('cobros').delete().eq('id', made.charge).eq('academia_id', academiaId);
        if (made.link) await supabase.from('jugador_categoria').delete().eq('id', made.link);
        if (made.enrollment) await supabase.from('inscripciones_deportivas').delete().eq('id', made.enrollment).eq('academia_id', academiaId);
        if (made.player) await supabase.from('jugadores').delete().eq('id', made.player).eq('academia_id', academiaId);
        if (made.tutor) {
          const { count } = await supabase.from('jugadores').select('id', { count: 'exact', head: true }).eq('academia_id', academiaId).eq('tutor_id', made.tutor);
          if (!count) await supabase.from('tutores').delete().eq('id', made.tutor).eq('academia_id', academiaId);
        }
        if (made.category) {
          const [{ count: enrollmentCount }, { count: linkCount }] = await Promise.all([
            supabase.from('inscripciones_deportivas').select('id', { count: 'exact', head: true }).eq('categoria_id', made.category),
            supabase.from('jugador_categoria').select('id', { count: 'exact', head: true }).eq('categoria_id', made.category),
          ]);
          if (!enrollmentCount && !linkCount) {
            await supabase.from('categorias').delete().eq('id', made.category).eq('academia_id', academiaId);
            categoryCache.delete(nameKey(row.categoria));
          }
        }
        failed += 1;
        rowErrors.push({ fila: row.fila, error: rowError?.message || 'Error de importación' });
      }
    }

    const estado = failed ? (imported ? 'parcial' : 'error') : 'completado';
    const fullSummary = { total: validated.length, imported, created_players: createdPlayers, enrolled_existing: enrolledExisting, skipped, failed, rama_id: ramaId, rama: scope.branch.nombre, disciplina: scope.branch.disciplina, sede_id: scope.sede_id, sede: scope.branch.sedes?.nombre || null, errores: rowErrors.slice(0, 100) };
    await supabase.from('import_lotes').update({ estado, filas_importadas: imported, filas_omitidas: skipped, filas_error: failed, resumen: fullSummary, completed_at: new Date().toISOString() }).eq('id', loteId).eq('academia_id', academiaId);
    return res.status(201).json({ success: true, lote_id: loteId, estado, scope: { rama_id: ramaId, rama_nombre: scope.branch.nombre, disciplina: scope.branch.disciplina, sede_id: scope.sede_id, sede_nombre: scope.branch.sedes?.nombre || null }, summary: { total: validated.length, imported, created_players: createdPlayers, enrolled_existing: enrolledExisting, skipped, failed }, errors: rowErrors });
  } catch (error) {
    if (loteId) await supabase.from('import_lotes').update({ estado: 'error', completed_at: new Date().toISOString(), resumen: { error: error?.message || 'Error' } }).eq('id', loteId).eq('academia_id', academiaId);
    console.error('Error importando base:', error?.message || error);
    return res.status(error?.status || 500).json({ success: false, code: error?.code, error: error?.status ? error.message : 'No fue posible completar la importación.' });
  }
});

router.get('/lotes', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('import_lotes').select('*,ramas(id,nombre,disciplina),sedes(id,nombre)').eq('academia_id', req.user.academia_id).order('created_at', { ascending: false }).limit(30);
  if (error) return res.status(500).json({ success: false, error: 'No fue posible cargar el historial.' });
  return res.json({ success: true, data });
});

router.post('/lotes/:id/revertir', authMiddleware, async (req, res) => {
  try {
    const academiaId = req.user.academia_id;
    const { data: lote, error: loteError } = await supabase.from('import_lotes').select('id,estado,rama_id,sede_id').eq('id', req.params.id).eq('academia_id', academiaId).maybeSingle();
    if (loteError) throw loteError;
    if (!lote) return res.status(404).json({ success: false, error: 'Importación no encontrada.' });
    if (lote.estado === 'revertido') return res.status(409).json({ success: false, error: 'Esta importación ya fue revertida.' });
    const { data: items, error } = await supabase.from('import_lote_items').select('entidad,entidad_id,accion').eq('lote_id', lote.id).eq('academia_id', academiaId).eq('accion', 'creado');
    if (error) throw error;
    const ids = (entity) => [...new Set((items || []).filter((item) => item.entidad === entity && item.entidad_id).map((item) => item.entidad_id))];
    const chargeIds = ids('cobro');
    const linkIds = ids('jugador_categoria');
    const enrollmentIds = ids('inscripcion');
    const playerIds = ids('jugador');
    const tutorIds = ids('tutor');
    const categoryIds = ids('categoria');
    if (chargeIds.length) { const { error: e } = await supabase.from('cobros').delete().eq('academia_id', academiaId).in('id', chargeIds); if (e) throw e; }
    if (linkIds.length) { const { error: e } = await supabase.from('jugador_categoria').delete().in('id', linkIds); if (e) throw e; }
    if (enrollmentIds.length) { const { error: e } = await supabase.from('inscripciones_deportivas').delete().eq('academia_id', academiaId).in('id', enrollmentIds); if (e) throw e; }
    if (playerIds.length) { const { error: e } = await supabase.from('jugadores').delete().eq('academia_id', academiaId).in('id', playerIds); if (e) throw e; }

    let preservedTutors = 0;
    for (const id of tutorIds) {
      const { count } = await supabase.from('jugadores').select('id', { count: 'exact', head: true }).eq('academia_id', academiaId).eq('tutor_id', id);
      if (!count) { const { error: e } = await supabase.from('tutores').delete().eq('academia_id', academiaId).eq('id', id); if (e) preservedTutors += 1; } else preservedTutors += 1;
    }
    let preservedCategories = 0;
    for (const id of categoryIds) {
      const [{ count: enrollmentCount }, { count: linkCount }] = await Promise.all([
        supabase.from('inscripciones_deportivas').select('id', { count: 'exact', head: true }).eq('categoria_id', id),
        supabase.from('jugador_categoria').select('id', { count: 'exact', head: true }).eq('categoria_id', id),
      ]);
      if (enrollmentCount || linkCount) { preservedCategories += 1; continue; }
      const { error: e } = await supabase.from('categorias').delete().eq('academia_id', academiaId).eq('id', id);
      if (e) preservedCategories += 1;
    }
    const rollback = { alumnos_eliminados: playerIds.length, inscripciones_eliminadas: enrollmentIds.length, cobros_eliminados: chargeIds.length, categorias_conservadas_por_uso: preservedCategories, apoderados_conservados_por_uso: preservedTutors };
    await supabase.from('import_lotes').update({ estado: 'revertido', reverted_at: new Date().toISOString(), resumen: { rollback, rama_id: lote.rama_id, sede_id: lote.sede_id } }).eq('id', lote.id).eq('academia_id', academiaId);
    return res.json({ success: true, rollback });
  } catch (error) {
    console.error('Error revirtiendo importación:', error?.message || error);
    return res.status(500).json({ success: false, error: 'No fue posible revertir la importación.' });
  }
});

module.exports = router;
