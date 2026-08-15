const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');

const text = (value, max = 250) => String(value ?? '').trim().slice(0, max);
const normalizeRut = (value) => text(value, 40).replace(/\./g, '').replace(/\s/g, '').toUpperCase();
const numberOrZero = (value) => {
  const normalized = String(value ?? '').replace(/\$/g, '').replace(/\./g, '').replace(/,/g, '.').trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};
const dateOrNull = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const normalizeRow = (raw = {}, index = 0) => ({
  fila: index + 2,
  nombre_alumno: text(raw.nombre_alumno, 180),
  rut_alumno: normalizeRut(raw.rut_alumno),
  fecha_nacimiento: dateOrNull(raw.fecha_nacimiento),
  sexo: text(raw.sexo, 40),
  posicion: text(raw.posicion, 80),
  categoria: text(raw.categoria, 120),
  nombre_apoderado: text(raw.nombre_apoderado, 180),
  rut_apoderado: normalizeRut(raw.rut_apoderado),
  telefono_apoderado: text(raw.telefono_apoderado, 80),
  email_apoderado: text(raw.email_apoderado, 240).toLowerCase(),
  monto_matricula: numberOrZero(raw.monto_matricula),
  mensualidad: numberOrZero(raw.mensualidad),
  saldo_pendiente: numberOrZero(raw.saldo_pendiente),
  talla_uniforme: text(raw.talla_uniforme, 40),
  numero_camiseta: raw.numero_camiseta === '' || raw.numero_camiseta == null ? null : Number(raw.numero_camiseta),
  estado: text(raw.estado, 40) || 'Activo',
});

const validateRows = async (academiaId, rows) => {
  const normalized = rows.slice(0, 3000).map(normalizeRow);
  const playerRuts = [...new Set(normalized.map((r) => r.rut_alumno).filter(Boolean))];
  let existingRuts = new Set();
  if (playerRuts.length) {
    const { data } = await supabase.from('jugadores').select('rut').eq('academia_id', academiaId).in('rut', playerRuts);
    existingRuts = new Set((data || []).map((r) => normalizeRut(r.rut)));
  }
  const seen = new Set();
  return normalized.map((row) => {
    const errors = [];
    const warnings = [];
    if (!row.nombre_alumno) errors.push('Falta nombre del alumno');
    if (!row.nombre_apoderado) warnings.push('Sin nombre de apoderado');
    if (!row.rut_apoderado) warnings.push('Sin documento de apoderado');
    if (row.email_apoderado && !/^\S+@\S+\.\S+$/.test(row.email_apoderado)) warnings.push('Correo de apoderado parece inválido');
    if (row.rut_alumno) {
      if (existingRuts.has(row.rut_alumno)) errors.push('Alumno ya existe en Syncademia');
      if (seen.has(row.rut_alumno)) errors.push('RUT de alumno duplicado dentro del archivo');
      seen.add(row.rut_alumno);
    }
    if (row.numero_camiseta != null && (!Number.isFinite(row.numero_camiseta) || row.numero_camiseta < 0 || row.numero_camiseta > 999)) warnings.push('Número de camiseta fuera de rango');
    return { ...row, valido: errors.length === 0, errors, warnings };
  });
};

router.post('/preview', authMiddleware, async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ success: false, error: 'No se recibieron filas para validar.' });
    if (rows.length > 3000) return res.status(400).json({ success: false, error: 'El archivo supera el máximo de 3.000 filas por importación.' });
    const data = await validateRows(req.user.academia_id, rows);
    const valid = data.filter((r) => r.valido).length;
    res.json({ success: true, summary: { total: data.length, valid, errors: data.length - valid, warnings: data.filter((r) => r.warnings.length).length }, data });
  } catch (error) {
    console.error('Error previsualizando importación:', error?.message || 'Error desconocido');
    res.status(500).json({ success: false, error: 'No fue posible validar el archivo.' });
  }
});

router.post('/commit', authMiddleware, async (req, res) => {
  const academiaId = req.user.academia_id;
  let loteId = null;
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const fileName = text(req.body?.file_name, 255);
    const validated = await validateRows(academiaId, rows);
    const accepted = validated.filter((r) => r.valido);
    if (!accepted.length) return res.status(400).json({ success: false, error: 'No hay filas válidas para importar.' });

    const { data: lote, error: batchError } = await supabase.from('import_lotes').insert([{
      academia_id: academiaId,
      nombre_archivo: fileName || null,
      estado: 'procesando',
      total_filas: validated.length,
      created_by: req.user.id || null,
    }]).select('id').single();
    if (batchError) throw batchError;
    loteId = lote.id;

    const categoryCache = new Map();
    const tutorCache = new Map();
    let imported = 0;
    let skipped = validated.length - accepted.length;
    let failed = 0;
    const rowErrors = [];

    for (const row of accepted) {
      try {
        let categoryId = null;
        if (row.categoria) {
          const key = row.categoria.toLowerCase();
          if (categoryCache.has(key)) categoryId = categoryCache.get(key);
          else {
            const { data: existing } = await supabase.from('categorias').select('id').eq('academia_id', academiaId).ilike('nombre', row.categoria).limit(1).maybeSingle();
            if (existing) categoryId = existing.id;
            else {
              const { data: created, error } = await supabase.from('categorias').insert([{ academia_id: academiaId, nombre: row.categoria }]).select('id').single();
              if (error) throw error;
              categoryId = created.id;
              await supabase.from('import_lote_items').insert([{ lote_id: loteId, academia_id: academiaId, fila: row.fila, entidad: 'categoria', entidad_id: categoryId, accion: 'creado', detalle: { nombre: row.categoria } }]);
            }
            categoryCache.set(key, categoryId);
          }
        }

        let tutorId = null;
        const tutorKey = row.rut_apoderado || row.email_apoderado || `${row.nombre_apoderado}|${row.telefono_apoderado}`;
        if (row.nombre_apoderado && tutorKey) {
          if (tutorCache.has(tutorKey)) tutorId = tutorCache.get(tutorKey);
          else {
            let query = supabase.from('tutores').select('id').eq('academia_id', academiaId);
            if (row.rut_apoderado) query = query.eq('rut', row.rut_apoderado);
            else if (row.email_apoderado) query = query.eq('email', row.email_apoderado);
            else query = query.eq('nombre_completo', row.nombre_apoderado);
            const { data: existing } = await query.limit(1).maybeSingle();
            if (existing) tutorId = existing.id;
            else {
              const { data: created, error } = await supabase.from('tutores').insert([{
                academia_id: academiaId,
                nombre_completo: row.nombre_apoderado,
                rut: row.rut_apoderado || null,
                telefono: row.telefono_apoderado || null,
                email: row.email_apoderado || null,
              }]).select('id').single();
              if (error) throw error;
              tutorId = created.id;
              await supabase.from('import_lote_items').insert([{ lote_id: loteId, academia_id: academiaId, fila: row.fila, entidad: 'tutor', entidad_id: tutorId, accion: 'creado', detalle: { nombre: row.nombre_apoderado } }]);
            }
            tutorCache.set(tutorKey, tutorId);
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
          saldo_pendiente: Math.max(0, row.saldo_pendiente),
          estado_financiero: row.saldo_pendiente > 0 ? 'Moroso' : 'Al Día',
        }]).select('id').single();
        if (playerError) throw playerError;
        await supabase.from('import_lote_items').insert([{ lote_id: loteId, academia_id: academiaId, fila: row.fila, entidad: 'jugador', entidad_id: player.id, accion: 'creado', detalle: { nombre: row.nombre_alumno } }]);

        if (categoryId) await supabase.from('jugador_categoria').insert([{ jugador_id: player.id, categoria_id: categoryId }]);
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
          await supabase.from('import_lote_items').insert([{ lote_id: loteId, academia_id: academiaId, fila: row.fila, entidad: 'cobro', entidad_id: charge.id, accion: 'creado', detalle: { concepto: 'Saldo inicial migrado' } }]);
        }
        imported += 1;
      } catch (rowError) {
        failed += 1;
        rowErrors.push({ fila: row.fila, error: rowError?.message || 'Error de importación' });
      }
    }

    const status = failed ? (imported ? 'parcial' : 'error') : 'completado';
    await supabase.from('import_lotes').update({
      estado: status, filas_importadas: imported, filas_omitidas: skipped, filas_error: failed,
      resumen: { errores: rowErrors.slice(0, 100) }, completed_at: new Date().toISOString(),
    }).eq('id', loteId).eq('academia_id', academiaId);

    res.status(201).json({ success: true, lote_id: loteId, estado: status, summary: { total: validated.length, imported, skipped, failed }, errors: rowErrors });
  } catch (error) {
    if (loteId) await supabase.from('import_lotes').update({ estado: 'error', completed_at: new Date().toISOString(), resumen: { error: error?.message || 'Error' } }).eq('id', loteId).eq('academia_id', academiaId);
    console.error('Error importando base:', error?.message || 'Error desconocido');
    res.status(500).json({ success: false, error: 'No fue posible completar la importación.' });
  }
});

router.get('/lotes', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('import_lotes').select('*').eq('academia_id', req.user.academia_id).order('created_at', { ascending: false }).limit(30);
  if (error) return res.status(500).json({ success: false, error: 'No fue posible cargar el historial.' });
  res.json({ success: true, data });
});

router.post('/lotes/:id/revertir', authMiddleware, async (req, res) => {
  try {
    const academiaId = req.user.academia_id;
    const { data: lote } = await supabase.from('import_lotes').select('id,estado').eq('id', req.params.id).eq('academia_id', academiaId).maybeSingle();
    if (!lote) return res.status(404).json({ success: false, error: 'Importación no encontrada.' });
    if (lote.estado === 'revertido') return res.status(409).json({ success: false, error: 'Esta importación ya fue revertida.' });

    const { data: items, error } = await supabase.from('import_lote_items').select('entidad,entidad_id,accion').eq('lote_id', lote.id).eq('academia_id', academiaId).eq('accion', 'creado');
    if (error) throw error;
    const ids = (entity) => (items || []).filter((i) => i.entidad === entity && i.entidad_id).map((i) => i.entidad_id);
    const chargeIds = ids('cobro');
    const playerIds = ids('jugador');
    const tutorIds = ids('tutor');
    const categoryIds = ids('categoria');

    if (chargeIds.length) await supabase.from('cobros').delete().eq('academia_id', academiaId).in('id', chargeIds);
    if (playerIds.length) await supabase.from('jugadores').delete().eq('academia_id', academiaId).in('id', playerIds);
    for (const tutorId of tutorIds) {
      const { count } = await supabase.from('jugadores').select('id', { count: 'exact', head: true }).eq('academia_id', academiaId).eq('tutor_id', tutorId);
      if (!count) await supabase.from('tutores').delete().eq('academia_id', academiaId).eq('id', tutorId);
    }
    for (const categoryId of categoryIds) {
      const { count } = await supabase.from('jugador_categoria').select('id', { count: 'exact', head: true }).eq('categoria_id', categoryId);
      if (!count) await supabase.from('categorias').delete().eq('academia_id', academiaId).eq('id', categoryId);
    }
    await supabase.from('import_lotes').update({ estado: 'revertido', reverted_at: new Date().toISOString() }).eq('id', lote.id).eq('academia_id', academiaId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error revirtiendo importación:', error?.message || 'Error desconocido');
    res.status(500).json({ success: false, error: 'No fue posible revertir la importación.' });
  }
});

module.exports = router;
