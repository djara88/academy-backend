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
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const ramaId = text(req.body?.rama_id, 80);
    if (!ramaId) return res.status(400).json({ success: false, error: 'Selecciona la rama a la que pertenecen los alumnos.' });
    if (!rows.length || rows.length > 3000) return res.status(400).json({ success: false, error: 'La importación debe contener entre 1 y 3.000 filas.' });

    const scope = await resolveScope(academiaId, ramaId);
    const [validated, capacity] = await Promise.all([
      validateRows(academiaId, ramaId, rows),
      getCapacity(academiaId),
    ]);
    const accepted = validated.filter((row) => row.valido);
    if (!accepted.length) return res.status(400).json({ success: false, error: 'No hay filas válidas para importar.' });

    const newPlayersRequired = accepted.filter((row) => row.modo === 'crear_alumno').length;
    if (capacity.remaining !== null && newPlayersRequired > capacity.remaining) {
      return res.status(403).json({
        success: false,
        code: 'PLAYER_LIMIT_REACHED',
        error: `Tu plan permite crear ${capacity.remaining} alumno(s) más. Esta importación necesita crear ${newPlayersRequired}; los alumnos ya existentes no consumen cupos adicionales.`,
        available_slots: capacity.remaining,
        new_players: newPlayersRequired,
      });
    }

    const atomicRows = accepted.map((row) => ({
      fila: row.fila,
      nombre_alumno: row.nombre_alumno,
      rut_alumno: row.rut_alumno,
      fecha_nacimiento: row.fecha_nacimiento,
      sexo: row.sexo,
      posicion: row.posicion,
      categoria: row.categoria,
      nombre_apoderado: row.nombre_apoderado,
      rut_apoderado: row.rut_apoderado,
      telefono_apoderado: row.telefono_apoderado,
      email_apoderado: row.email_apoderado,
      monto_matricula: row.monto_matricula,
      mensualidad: row.mensualidad,
      saldo_pendiente: row.saldo_pendiente,
      talla_uniforme: row.talla_uniforme,
      numero_camiseta: row.numero_camiseta,
      estado: row.estado,
      jugador_existente_id: row.jugador_existente_id,
    }));

    const { data, error } = await supabase.rpc('commit_player_import_v1', {
      p_academia_id: academiaId,
      p_sede_id: scope.sede_id,
      p_rama_id: ramaId,
      p_rows: atomicRows,
      p_file_name: text(req.body?.file_name, 255) || null,
      p_created_by: req.user.id || req.user.sub || null,
      p_total_rows: validated.length,
      p_skipped: validated.length - accepted.length,
    });

    if (error) {
      const detail = [error.message, error.details, error.hint].filter(Boolean).join(' ');
      const normalized = detail.toUpperCase();

      if (normalized.includes('PLAYER_LIMIT_REACHED')) {
        return res.status(403).json({
          success: false,
          code: 'PLAYER_LIMIT_REACHED',
          error: 'La academia alcanzó el máximo de alumnos permitido por su plan.',
        });
      }
      if (
        normalized.includes('IMPORT_ACTIVE_ENROLLMENT_EXISTS')
        || normalized.includes('IMPORT_DUPLICATE_PLAYER_DOCUMENT')
        || normalized.includes('IMPORT_PLAYER_SCOPE_MISMATCH')
        || normalized.includes('IMPORT_INVALID_SCOPE')
      ) {
        return res.status(409).json({
          success: false,
          code: 'IMPORT_CONFLICT',
          error: 'La base cambió desde la previsualización. Vuelve a validar el archivo antes de importarlo.',
        });
      }
      if (
        normalized.includes('IMPORT_ROW_LIMIT')
        || normalized.includes('IMPORT_ROWS_MUST_BE_ARRAY')
        || normalized.includes('IMPORT_PLAYER_NAME_REQUIRED')
        || normalized.includes('IMPORT_INVALID_SKIPPED_COUNT')
      ) {
        return res.status(400).json({
          success: false,
          code: 'IMPORT_VALIDATION_ERROR',
          error: 'El lote contiene datos inválidos y no fue aplicado.',
        });
      }
      throw error;
    }

    return res.status(201).json({
      success: true,
      lote_id: data?.lote_id,
      estado: data?.estado || 'completado',
      scope: data?.scope || {
        rama_id: ramaId,
        rama_nombre: scope.branch.nombre,
        disciplina: scope.branch.disciplina,
        sede_id: scope.sede_id,
        sede_nombre: scope.branch.sedes?.nombre || null,
      },
      summary: data?.summary || {
        total: validated.length,
        imported: accepted.length,
        created_players: newPlayersRequired,
        enrolled_existing: accepted.length - newPlayersRequired,
        skipped: validated.length - accepted.length,
        failed: 0,
      },
      errors: Array.isArray(data?.errors) ? data.errors : [],
      atomic: true,
    });
  } catch (error) {
    console.error('Error importando base de forma atómica:', error?.message || error);
    return res.status(error?.status || 500).json({
      success: false,
      code: error?.code,
      error: error?.status ? error.message : 'No fue posible completar la importación. No se aplicó ningún cambio parcial.',
    });
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
