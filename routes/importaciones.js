const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { getAcademyEntitlements } = require('../services/planCatalog');

const text = (value, max = 250) => String(value ?? '').trim().slice(0, max);
const normalizeDocument = (value) => text(value, 40).replace(/\./g, '').replace(/\s/g, '').toUpperCase();
const documentKey = (value) => normalizeDocument(value).replace(/[^0-9K]/g, '');
const numberOrZero = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const raw = String(value ?? '').replace(/[$\s]/g, '').trim();
  if (!raw) return 0;
  let normalized = raw;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(raw)) {
    normalized = raw.replace(/\./g, '').replace(',', '.');
  } else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw)) {
    normalized = raw.replace(/,/g, '');
  } else if (raw.includes(',')) {
    normalized = raw.replace(/\./g, '').replace(',', '.');
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};
const dateOrNull = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
const normalizeNameKey = (value) => text(value, 180).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const normalizeRow = (raw = {}, index = 0) => ({
  fila: index + 2,
  nombre_alumno: text(raw.nombre_alumno, 180),
  rut_alumno: normalizeDocument(raw.rut_alumno),
  fecha_nacimiento: dateOrNull(raw.fecha_nacimiento),
  sexo: text(raw.sexo, 40),
  posicion: text(raw.posicion, 80),
  categoria: text(raw.categoria, 120),
  nombre_apoderado: text(raw.nombre_apoderado, 180),
  rut_apoderado: normalizeDocument(raw.rut_apoderado),
  telefono_apoderado: text(raw.telefono_apoderado, 80),
  email_apoderado: text(raw.email_apoderado, 240).toLowerCase(),
  monto_matricula: numberOrZero(raw.monto_matricula),
  mensualidad: numberOrZero(raw.mensualidad),
  saldo_pendiente: Math.max(0, numberOrZero(raw.saldo_pendiente)),
  talla_uniforme: text(raw.talla_uniforme, 40),
  numero_camiseta: raw.numero_camiseta === '' || raw.numero_camiseta == null ? null : Number(raw.numero_camiseta),
  estado: text(raw.estado, 40) || 'Activo',
});

const getPlayerCapacity = async (academiaId) => {
  const [academyResult, countResult] = await Promise.all([
    supabase.from('academias').select('*').eq('id', academiaId).single(),
    supabase.from('jugadores').select('id', { count: 'exact', head: true }).eq('academia_id', academiaId),
  ]);
  if (academyResult.error || countResult.error) throw academyResult.error || countResult.error;
  const limit = getAcademyEntitlements(academyResult.data || {}).limits.players;
  const current = Number(countResult.count || 0);
  return { limit, current, remaining: Number.isInteger(limit) ? Math.max(0, limit - current) : null };
};

const validateRows = async (academiaId, rows) => {
  const normalized = rows.slice(0, 3000).map(normalizeRow);
  const { data: existingPlayers, error } = await supabase.from('jugadores').select('rut').eq('academia_id', academiaId);
  if (error) throw error;
  const existingKeys = new Set((existingPlayers || []).map((r) => documentKey(r.rut)).filter(Boolean));
  const seen = new Set();

  return normalized.map((row) => {
    const errors = [];
    const warnings = [];
    const key = documentKey(row.rut_alumno);
    if (!row.nombre_alumno) errors.push('Falta nombre del alumno');
    if (!row.nombre_apoderado) warnings.push('Sin nombre de apoderado');
    if (!row.rut_apoderado) warnings.push('Sin documento de apoderado');
    if (row.email_apoderado && !/^\S+@\S+\.\S+$/.test(row.email_apoderado)) warnings.push('Correo de apoderado parece inválido');
    if (key) {
      if (existingKeys.has(key)) errors.push('Alumno ya existe en Syncademia');
      if (seen.has(key)) errors.push('Documento de alumno duplicado dentro del archivo');
      seen.add(key);
    } else warnings.push('Alumno sin documento: la detección automática de duplicados será limitada');
    if (row.numero_camiseta != null && (!Number.isFinite(row.numero_camiseta) || row.numero_camiseta < 0 || row.numero_camiseta > 999)) warnings.push('Número de camiseta fuera de rango');
    return { ...row, valido: errors.length === 0, errors, warnings };
  });
};

router.post('/preview', authMiddleware, async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ success: false, error: 'No se recibieron filas para validar.' });
    if (rows.length > 3000) return res.status(400).json({ success: false, error: 'El archivo supera el máximo de 3.000 filas por importación.' });

    const [data, capacity] = await Promise.all([
      validateRows(req.user.academia_id, rows),
      getPlayerCapacity(req.user.academia_id),
    ]);
    const valid = data.filter((r) => r.valido).length;
    return res.json({
      success: true,
      summary: {
        total: data.length,
        valid,
        errors: data.length - valid,
        warnings: data.filter((r) => r.warnings.length).length,
        player_limit: capacity.limit,
        current_players: capacity.current,
        available_slots: capacity.remaining,
        capacity_exceeded: capacity.remaining !== null && valid > capacity.remaining,
      },
      data,
    });
  } catch (error) {
    console.error('Error previsualizando importación:', error?.message || 'Error desconocido');
    return res.status(500).json({ success: false, error: 'No fue posible validar el archivo.' });
  }
});

router.post('/commit', authMiddleware, async (req, res) => {
  const academiaId = req.user.academia_id;
  let loteId = null;
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length || rows.length > 3000) return res.status(400).json({ success: false, error: 'La importación debe contener entre 1 y 3.000 filas.' });
    const fileName = text(req.body?.file_name, 255);
    const [validated, capacity] = await Promise.all([validateRows(academiaId, rows), getPlayerCapacity(academiaId)]);
    const accepted = validated.filter((r) => r.valido);
    if (!accepted.length) return res.status(400).json({ success: false, error: 'No hay filas válidas para importar.' });
    if (capacity.remaining !== null && accepted.length > capacity.remaining) {
      return res.status(403).json({
        success: false,
        code: 'PLAYER_LIMIT_REACHED',
        error: `Tu plan permite importar ${capacity.remaining} jugador(es) más. El archivo contiene ${accepted.length} filas válidas.`,
        limit: capacity.limit,
        current: capacity.current,
        available_slots: capacity.remaining,
      });
    }

    const { data: lote, error: batchError } = await supabase.from('import_lotes').insert([{
      academia_id: academiaId,
      nombre_archivo: fileName || null,
      estado: 'procesando',
      total_filas: validated.length,
      created_by: req.user.id || null,
    }]).select('id').single();
    if (batchError) throw batchError;
    loteId = lote.id;

    const [{ data: existingCategories }, { data: existingTutors }] = await Promise.all([
      supabase.from('categorias').select('id,nombre').eq('academia_id', academiaId),
      supabase.from('tutores').select('id,rut,email,nombre_completo,telefono').eq('academia_id', academiaId),
    ]);
    const categoryCache = new Map((existingCategories || []).map((c) => [normalizeNameKey(c.nombre), c.id]));
    const tutorCache = new Map();
    (existingTutors || []).forEach((t) => {
      const doc = documentKey(t.rut);
      if (doc) tutorCache.set(`doc:${doc}`, t.id);
      if (t.email) tutorCache.set(`mail:${String(t.email).toLowerCase()}`, t.id);
      if (t.nombre_completo) tutorCache.set(`name:${normalizeNameKey(t.nombre_completo)}|${text(t.telefono, 80)}`, t.id);
    });

    let imported = 0;
    const skipped = validated.length - accepted.length;
    let failed = 0;
    const rowErrors = [];

    const recordItem = async (row, entidad, entidadId, detalle) => {
      const { error } = await supabase.from('import_lote_items').insert([{
        lote_id: loteId, academia_id: academiaId, fila: row.fila, entidad, entidad_id: entidadId, accion: 'creado', detalle,
      }]);
      if (error) throw error;
    };

    for (const row of accepted) {
      let playerId = null;
      try {
        let categoryId = null;
        if (row.categoria) {
          const key = normalizeNameKey(row.categoria);
          categoryId = categoryCache.get(key) || null;
          if (!categoryId) {
            const { data: created, error } = await supabase.from('categorias').insert([{ academia_id: academiaId, nombre: row.categoria }]).select('id').single();
            if (error) throw error;
            categoryId = created.id;
            categoryCache.set(key, categoryId);
            await recordItem(row, 'categoria', categoryId, { nombre: row.categoria });
          }
        }

        let tutorId = null;
        if (row.nombre_apoderado) {
          const candidateKeys = [
            documentKey(row.rut_apoderado) ? `doc:${documentKey(row.rut_apoderado)}` : null,
            row.email_apoderado ? `mail:${row.email_apoderado}` : null,
            `name:${normalizeNameKey(row.nombre_apoderado)}|${row.telefono_apoderado}`,
          ].filter(Boolean);
          tutorId = candidateKeys.map((key) => tutorCache.get(key)).find(Boolean) || null;
          if (!tutorId) {
            const { data: created, error } = await supabase.from('tutores').insert([{
              academia_id: academiaId,
              nombre_completo: row.nombre_apoderado,
              rut: row.rut_apoderado || null,
              telefono: row.telefono_apoderado || null,
              email: row.email_apoderado || null,
            }]).select('id').single();
            if (error) throw error;
            tutorId = created.id;
            candidateKeys.forEach((key) => tutorCache.set(key, tutorId));
            await recordItem(row, 'tutor', tutorId, { nombre: row.nombre_apoderado });
          }
        }

        const { data: player, error: playerError } = await supabase.from('jugadores').insert([{
          academia_id: academiaId,
          tutor_id: tutorId,
          categoria_id: categoryId,
          nombre: row.nombre_alumno,
          rut: row.rut_alumno || null,
          fecha_nacimiento: row.fecha_nacimiento,
          sexo: row.sexo || null,
          posicion_cancha: row.posicion || null,
          tipo_alumno: 'Antiguo',
          estado: row.estado,
          estado_matricula: 'Migrado',
          monto_matricula: row.monto_matricula,
          monto_mensualidad: row.mensualidad,
          talla_uniforme: row.talla_uniforme || null,
          numero_camiseta: Number.isFinite(row.numero_camiseta) ? row.numero_camiseta : null,
          saldo_pendiente: row.saldo_pendiente,
          estado_financiero: row.saldo_pendiente > 0 ? 'Moroso' : 'Al Día',
        }]).select('id').single();
        if (playerError) throw playerError;
        playerId = player.id;
        await recordItem(row, 'jugador', player.id, { nombre: row.nombre_alumno });

        if (categoryId) {
          const { error } = await supabase.from('jugador_categoria').insert([{ jugador_id: player.id, categoria_id: categoryId }]);
          if (error) throw error;
        }

        if (row.saldo_pendiente > 0) {
          const { data: charge, error } = await supabase.from('cobros').insert([{
            academia_id: academiaId,
            jugador_id: player.id,
            concepto: 'Saldo inicial migrado',
            tipo_concepto: 'Migración',
            monto: row.saldo_pendiente,
            monto_pagado: 0,
            estado: 'Pendiente',
            fecha_vencimiento: new Date().toISOString().slice(0, 10),
          }]).select('id').single();
          if (error) throw error;
          await recordItem(row, 'cobro', charge.id, { concepto: 'Saldo inicial migrado' });
        }
        imported += 1;
      } catch (rowError) {
        if (playerId) await supabase.from('jugadores').delete().eq('academia_id', academiaId).eq('id', playerId);
        failed += 1;
        rowErrors.push({ fila: row.fila, error: rowError?.message || 'Error de importación' });
      }
    }

    const status = failed ? (imported ? 'parcial' : 'error') : 'completado';
    await supabase.from('import_lotes').update({
      estado: status,
      filas_importadas: imported,
      filas_omitidas: skipped,
      filas_error: failed,
      resumen: { errores: rowErrors.slice(0, 100) },
      completed_at: new Date().toISOString(),
    }).eq('id', loteId).eq('academia_id', academiaId);

    return res.status(201).json({
      success: true,
      lote_id: loteId,
      estado: status,
      summary: { total: validated.length, imported, skipped, failed },
      errors: rowErrors,
    });
  } catch (error) {
    if (loteId) {
      await supabase.from('import_lotes').update({
        estado: 'error', completed_at: new Date().toISOString(), resumen: { error: error?.message || 'Error' },
      }).eq('id', loteId).eq('academia_id', academiaId);
    }
    console.error('Error importando base:', error?.message || 'Error desconocido');
    return res.status(500).json({ success: false, error: 'No fue posible completar la importación.' });
  }
});

router.get('/lotes', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('import_lotes')
    .select('*').eq('academia_id', req.user.academia_id).order('created_at', { ascending: false }).limit(30);
  if (error) return res.status(500).json({ success: false, error: 'No fue posible cargar el historial.' });
  return res.json({ success: true, data });
});

router.post('/lotes/:id/revertir', authMiddleware, async (req, res) => {
  try {
    const academiaId = req.user.academia_id;
    const { data: lote } = await supabase.from('import_lotes').select('id,estado').eq('id', req.params.id).eq('academia_id', academiaId).maybeSingle();
    if (!lote) return res.status(404).json({ success: false, error: 'Importación no encontrada.' });
    if (lote.estado === 'revertido') return res.status(409).json({ success: false, error: 'Esta importación ya fue revertida.' });

    const { data: items, error } = await supabase.from('import_lote_items')
      .select('entidad,entidad_id,accion').eq('lote_id', lote.id).eq('academia_id', academiaId).eq('accion', 'creado');
    if (error) throw error;
    const ids = (entity) => [...new Set((items || []).filter((i) => i.entidad === entity && i.entidad_id).map((i) => i.entidad_id))];
    const playerIds = ids('jugador');
    const tutorIds = ids('tutor');
    const categoryIds = ids('categoria');

    if (playerIds.length) {
      const { error: deleteError } = await supabase.from('jugadores').delete().eq('academia_id', academiaId).in('id', playerIds);
      if (deleteError) throw deleteError;
    }

    for (const tutorId of tutorIds) {
      const { count } = await supabase.from('jugadores').select('id', { count: 'exact', head: true }).eq('academia_id', academiaId).eq('tutor_id', tutorId);
      if (!count) await supabase.from('tutores').delete().eq('academia_id', academiaId).eq('id', tutorId);
    }

    let preservedCategories = 0;
    for (const categoryId of categoryIds) {
      const { count } = await supabase.from('jugador_categoria').select('id', { count: 'exact', head: true }).eq('categoria_id', categoryId);
      if (count) { preservedCategories += 1; continue; }
      const { error: categoryDeleteError } = await supabase.from('categorias').delete().eq('academia_id', academiaId).eq('id', categoryId);
      if (categoryDeleteError) preservedCategories += 1;
    }

    await supabase.from('import_lotes').update({
      estado: 'revertido',
      reverted_at: new Date().toISOString(),
      resumen: { rollback: { jugadores_eliminados: playerIds.length, categorias_conservadas_por_uso: preservedCategories } },
    }).eq('id', lote.id).eq('academia_id', academiaId);

    return res.json({ success: true, preserved_categories: preservedCategories });
  } catch (error) {
    console.error('Error revirtiendo importación:', error?.message || 'Error desconocido');
    return res.status(500).json({ success: false, error: 'No fue posible revertir la importación.' });
  }
});

module.exports = router;
