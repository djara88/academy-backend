const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { getBranch, safeText } = require('../services/branchContext');
const { createSportEnrollment } = require('../services/sportEnrollmentService');

const router = express.Router();
router.use(authMiddleware, requireDirector);

const maxImportMb = Math.max(1, Number(process.env.MAX_IMPORT_MB || 8));
const maxImportRows = Math.max(10, Number(process.env.MAX_IMPORT_ROWS || 1500));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxImportMb * 1024 * 1024, files: 1 } });

const normalizeHeader = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const compact = (value) => normalizeHeader(value).replace(/\s+/g, '');
const normalizeDocument = (value) => String(value || '').toUpperCase().replace(/[^0-9K]/g, '');
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const normalizePhone = (value) => String(value || '').replace(/[^0-9+]/g, '').slice(0, 30);
const normalizeCategoryKey = (value) => normalizeHeader(value);
const clean = (value, max = 180) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const aliases = {
  nombre: ['nombre','nombre alumno','alumno','jugador','nombre jugador','nombre completo','nombre deportista'],
  documento: ['rut','run','documento','rut alumno','run alumno','documento alumno','pasaporte'],
  fecha_nacimiento: ['fecha nacimiento','fecha de nacimiento','nacimiento','f nacimiento'],
  categoria: ['categoria','categoría','nivel','grupo','curso'],
  tutor_nombre: ['apoderado','nombre apoderado','tutor','nombre tutor','apoderado principal'],
  tutor_email: ['email apoderado','correo apoderado','email tutor','correo tutor','mail apoderado'],
  tutor_telefono: ['telefono apoderado','teléfono apoderado','telefono tutor','celular apoderado','whatsapp'],
  alerta_medica: ['alerta medica','alerta médica','observacion medica','observación médica','condicion medica','condición médica'],
  telefono_emergencia: ['telefono emergencia','teléfono emergencia','contacto emergencia'],
  talla_uniforme: ['talla','talla uniforme','talla polera','talla camiseta'],
  numero_camiseta: ['numero','número','numero camiseta','dorsal'],
};

const aliasMap = new Map();
Object.entries(aliases).forEach(([field, values]) => values.forEach((value) => aliasMap.set(compact(value), field)));

const mapRows = (sheetRows) => {
  if (!Array.isArray(sheetRows) || !sheetRows.length) return { headers: [], detected: {}, rows: [] };
  const headers = Object.keys(sheetRows[0] || {});
  const detected = {};
  headers.forEach((header) => {
    const field = aliasMap.get(compact(header));
    if (field && !detected[field]) detected[field] = header;
  });
  const rows = sheetRows.map((row, index) => {
    const mapped = { fila: index + 2 };
    Object.entries(detected).forEach(([field, header]) => { mapped[field] = row[header]; });
    return mapped;
  });
  return { headers, detected, rows };
};

const parseFile = (file) => {
  const extension = String(file.originalname || '').toLowerCase().split('.').pop();
  if (!['xlsx','xls','csv'].includes(extension)) throw Object.assign(new Error('Formato inválido. Usa XLSX, XLS o CSV.'), { status: 400 });
  const workbook = XLSX.read(file.buffer, { type: 'buffer', cellDates: true, raw: false });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!firstSheet) throw Object.assign(new Error('El archivo no contiene una hoja legible.'), { status: 400 });
  const records = XLSX.utils.sheet_to_json(firstSheet, { defval: '', raw: false });
  if (records.length > maxImportRows) throw Object.assign(new Error(`El archivo supera el máximo de ${maxImportRows} filas por importación.`), { status: 400 });
  return mapRows(records);
};

const parseDate = (value) => {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0,10);
  const text = String(value).trim();
  const iso = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2,'0')}-${iso[3].padStart(2,'0')}`;
  const latin = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (latin) return `${latin[3]}-${latin[2].padStart(2,'0')}-${latin[1].padStart(2,'0')}`;
  return null;
};

const sanitizeRow = (row) => ({
  fila: Number(row.fila) || null,
  nombre: clean(row.nombre, 180),
  documento: normalizeDocument(row.documento),
  fecha_nacimiento: parseDate(row.fecha_nacimiento),
  categoria: clean(row.categoria, 120),
  tutor_nombre: clean(row.tutor_nombre, 180),
  tutor_email: normalizeEmail(row.tutor_email),
  tutor_telefono: normalizePhone(row.tutor_telefono),
  alerta_medica: clean(row.alerta_medica, 500),
  telefono_emergencia: normalizePhone(row.telefono_emergencia),
  talla_uniforme: clean(row.talla_uniforme, 30),
  numero_camiseta: Number.isFinite(Number(row.numero_camiseta)) ? Math.max(0, Math.min(999, Number(row.numero_camiseta))) : null,
});

const loadBranchCategories = async (academyId, branchId) => {
  const { data, error } = await supabase.from('categorias')
    .select('id,nombre,sede_id,rama_id').eq('academia_id', academyId).eq('rama_id', branchId).order('nombre');
  if (error) throw error;
  return data || [];
};

const findOrCreateCategory = async ({ academyId, branch, name, cache }) => {
  if (!name) return { category: null, created: false };
  const key = normalizeCategoryKey(name);
  if (cache.has(key)) return { category: cache.get(key), created: false };
  const { data: existing, error: existingError } = await supabase.from('categorias')
    .select('id,nombre,sede_id,rama_id').eq('academia_id', academyId).eq('rama_id', branch.id).ilike('nombre', name).limit(1).maybeSingle();
  if (existingError) throw existingError;
  if (existing) { cache.set(key, existing); return { category: existing, created: false }; }
  const { data, error } = await supabase.from('categorias').insert({
    academia_id: academyId, sede_id: branch.sede_id, rama_id: branch.id, nombre: name,
    descripcion: `Creada durante importación masiva · ${branch.disciplina}`,
  }).select('id,nombre,sede_id,rama_id').single();
  if (error) {
    if (error.code === '23505') {
      const retry = await supabase.from('categorias').select('id,nombre,sede_id,rama_id')
        .eq('academia_id', academyId).eq('rama_id', branch.id).ilike('nombre', name).limit(1).maybeSingle();
      if (retry.error) throw retry.error;
      if (retry.data) { cache.set(key, retry.data); return { category: retry.data, created: false }; }
    }
    throw error;
  }
  cache.set(key, data);
  return { category: data, created: true };
};

const findOrCreateTutor = async ({ academyId, row }) => {
  if (!row.tutor_nombre && !row.tutor_email && !row.tutor_telefono) return { tutor: null, created: false };
  let query = supabase.from('tutores').select('id,nombre,nombre_completo,email,telefono').eq('academia_id', academyId);
  if (row.tutor_email) query = query.eq('email', row.tutor_email);
  else if (row.tutor_telefono) query = query.eq('telefono', row.tutor_telefono);
  else query = query.eq('nombre_completo', row.tutor_nombre);
  const { data: existing, error: existingError } = await query.limit(1).maybeSingle();
  if (existingError) throw existingError;
  if (existing) return { tutor: existing, created: false };
  const { data, error } = await supabase.from('tutores').insert({
    academia_id: academyId,
    nombre: row.tutor_nombre || 'Apoderado',
    nombre_completo: row.tutor_nombre || 'Apoderado',
    email: row.tutor_email || null,
    telefono: row.tutor_telefono || null,
  }).select('id,nombre,nombre_completo,email,telefono').single();
  if (error) throw error;
  return { tutor: data, created: true };
};

router.post('/preview', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Adjunta un archivo XLSX, XLS o CSV.' });
    const branchId = safeText(req.body?.rama_id || req.query?.rama_id, 80);
    const branch = await getBranch(req.user.academia_id, branchId);
    const parsed = parseFile(req.file);
    if (!parsed.detected.nombre || !parsed.detected.documento) {
      return res.status(400).json({ error: 'No pudimos detectar las columnas de Nombre y RUT/Documento.', detected: parsed.detected });
    }
    const rows = parsed.rows.map(sanitizeRow);
    const documents = [...new Set(rows.map((row) => row.documento).filter(Boolean))];
    let existingDocs = new Set();
    if (documents.length) {
      const { data, error } = await supabase.from('jugadores').select('rut,rut_pasaporte,numero_documento').eq('academia_id', req.user.academia_id)
        .or(documents.map((doc) => `rut.eq.${doc},rut_pasaporte.eq.${doc},numero_documento.eq.${doc}`).join(','));
      if (error) throw error;
      existingDocs = new Set((data || []).flatMap((item) => [item.rut,item.rut_pasaporte,item.numero_documento]).map(normalizeDocument).filter(Boolean));
    }
    const categories = await loadBranchCategories(req.user.academia_id, branch.id);
    const categoryKeys = new Set(categories.map((item) => normalizeCategoryKey(item.nombre)));
    const previewRows = rows.map((row) => {
      const errors = [];
      if (!row.nombre) errors.push('Falta nombre');
      if (!row.documento) errors.push('Falta documento');
      if (row.fecha_nacimiento === null && parsed.detected.fecha_nacimiento && parsed.rows.find((item) => item.fila === row.fila)?.fecha_nacimiento) errors.push('Fecha inválida');
      const duplicate = row.documento && existingDocs.has(row.documento);
      return {
        ...row,
        estado: errors.length ? 'error' : duplicate ? 'duplicado' : 'nuevo',
        errores: errors,
        categoria_estado: row.categoria ? (categoryKeys.has(normalizeCategoryKey(row.categoria)) ? 'existente_en_rama' : 'se_creara_en_rama') : 'sin_categoria',
      };
    });
    return res.json({
      success: true,
      data: {
        archivo: req.file.originalname,
        detected: parsed.detected,
        rama: branch,
        categorias_existentes: categories,
        rows: previewRows,
        resumen: {
          total: previewRows.length,
          nuevos: previewRows.filter((row) => row.estado === 'nuevo').length,
          duplicados: previewRows.filter((row) => row.estado === 'duplicado').length,
          errores: previewRows.filter((row) => row.estado === 'error').length,
        },
      },
    });
  } catch (error) {
    console.error('Error previsualizando importación multirrama:', error?.message || error);
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible procesar el archivo.' });
  }
});

router.post('/commit', async (req, res) => {
  let lote = null;
  try {
    const academyId = req.user.academia_id;
    const branchId = safeText(req.body?.rama_id, 80);
    const branch = await getBranch(academyId, branchId);
    const rows = Array.isArray(req.body?.rows) ? req.body.rows.map(sanitizeRow) : [];
    if (!rows.length) return res.status(400).json({ error: 'No hay filas para importar.' });
    if (rows.length > maxImportRows) return res.status(400).json({ error: `La importación supera ${maxImportRows} filas.` });

    const { data: createdLote, error: loteError } = await supabase.from('import_lotes').insert({
      academia_id: academyId,
      sede_id: branch.sede_id,
      rama_id: branch.id,
      nombre_archivo: safeText(req.body?.nombre_archivo, 250) || 'importacion',
      estado: 'procesando',
      total_filas: rows.length,
      filas_importadas: 0,
      filas_omitidas: 0,
      filas_error: 0,
      resumen: { rama: { id: branch.id, nombre: branch.nombre, disciplina: branch.disciplina } },
      created_by: req.user.id,
    }).select('*').single();
    if (loteError) throw loteError;
    lote = createdLote;

    const existingCategories = await loadBranchCategories(academyId, branch.id);
    const categoryCache = new Map(existingCategories.map((item) => [normalizeCategoryKey(item.nombre), item]));
    let imported = 0; let omitted = 0; let failed = 0;
    const results = [];

    for (const raw of rows) {
      const row = sanitizeRow(raw);
      let player = null;
      let tutor = null;
      let tutorCreated = false;
      try {
        if (!row.nombre || !row.documento) throw Object.assign(new Error('Nombre y documento son obligatorios.'), { rowError: true });
        const { data: duplicate, error: duplicateError } = await supabase.from('jugadores')
          .select('id,nombre').eq('academia_id', academyId)
          .or(`rut.eq.${row.documento},rut_pasaporte.eq.${row.documento},numero_documento.eq.${row.documento}`).limit(1).maybeSingle();
        if (duplicateError) throw duplicateError;
        if (duplicate) {
          omitted += 1;
          results.push({ fila: row.fila, estado: 'duplicado', mensaje: `${duplicate.nombre} ya existe en la academia.` });
          continue;
        }

        const tutorResult = await findOrCreateTutor({ academyId, row });
        tutor = tutorResult.tutor; tutorCreated = tutorResult.created;
        const categoryResult = await findOrCreateCategory({ academyId, branch, name: row.categoria, cache: categoryCache });
        const category = categoryResult.category;

        const { data: createdPlayer, error: playerError } = await supabase.from('jugadores').insert({
          academia_id: academyId,
          nombre: row.nombre,
          rut: row.documento,
          rut_pasaporte: row.documento,
          numero_documento: row.documento,
          fecha_nacimiento: row.fecha_nacimiento,
          tutor_id: tutor?.id || null,
          apoderado_id: tutor?.id || null,
          tutor_principal_id: tutor?.id || null,
          sede_id: branch.sede_id,
          rama_id: branch.id,
          categoria_id: category?.id || null,
          alerta_medica: row.alerta_medica || null,
          telefono_emergencia: row.telefono_emergencia || null,
          talla_uniforme: row.talla_uniforme || null,
          numero_camiseta: row.numero_camiseta,
          estado_financiero: 'Pendiente',
        }).select('id,nombre').single();
        if (playerError) throw playerError;
        player = createdPlayer;

        if (tutor?.id) {
          const { error: linkError } = await supabase.from('jugador_tutor')
            .upsert({ jugador_id: player.id, tutor_id: tutor.id, relacion: 'Apoderado/a', principal: true, puede_retirar: true }, { onConflict: 'jugador_id,tutor_id' });
          if (linkError) throw linkError;
        }

        const enrollment = await createSportEnrollment({
          academiaId: academyId,
          userId: req.user.id,
          jugadorId: player.id,
          sedeId: branch.sede_id,
          ramaId: branch.id,
          categoriaId: category?.id || null,
          montoMatricula: 0,
          montoMensualidad: 0,
        });

        const itemRows = [{
          lote_id: lote.id, academia_id: academyId, fila: row.fila, entidad: 'jugador', entidad_id: player.id, accion: 'creado',
          detalle: { nombre: row.nombre, documento: row.documento, rama_id: branch.id, categoria_id: category?.id || null, inscripcion_id: enrollment.id },
        }];
        if (tutorCreated && tutor?.id) itemRows.push({
          lote_id: lote.id, academia_id: academyId, fila: row.fila, entidad: 'tutor', entidad_id: tutor.id, accion: 'creado', detalle: { nombre: tutor.nombre_completo || tutor.nombre },
        });
        const { error: itemError } = await supabase.from('import_lote_items').insert(itemRows);
        if (itemError) throw itemError;
        imported += 1;
        results.push({ fila: row.fila, estado: 'importado', jugador_id: player.id, inscripcion_id: enrollment.id, categoria: category?.nombre || null });
      } catch (rowError) {
        failed += 1;
        if (player?.id) await supabase.from('jugadores').delete().eq('id', player.id).eq('academia_id', academyId);
        if (tutorCreated && tutor?.id) {
          const { count } = await supabase.from('jugador_tutor').select('jugador_id', { count: 'exact', head: true }).eq('tutor_id', tutor.id);
          if (!count) await supabase.from('tutores').delete().eq('id', tutor.id).eq('academia_id', academyId);
        }
        results.push({ fila: row.fila, estado: 'error', mensaje: rowError?.message || 'Error desconocido' });
      }
    }

    const summary = { importados: imported, omitidos: omitted, errores: failed, rama: { id: branch.id, nombre: branch.nombre, disciplina: branch.disciplina } };
    const { error: updateError } = await supabase.from('import_lotes').update({
      estado: failed && !imported ? 'error' : 'completado', filas_importadas: imported, filas_omitidas: omitted, filas_error: failed,
      resumen: summary, completed_at: new Date().toISOString(),
    }).eq('id', lote.id).eq('academia_id', academyId);
    if (updateError) throw updateError;
    return res.json({ success: true, data: { lote_id: lote.id, resumen: summary, resultados: results } });
  } catch (error) {
    if (lote?.id) await supabase.from('import_lotes').update({ estado: 'error', completed_at: new Date().toISOString(), resumen: { error: error?.message || 'Error fatal' } }).eq('id', lote.id);
    console.error('Error ejecutando importación multirrama:', error?.message || error);
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible completar la importación.' });
  }
});

module.exports = router;
