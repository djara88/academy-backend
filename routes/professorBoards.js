const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireProfessor } = require('../middleware/professorAccess');

const router = express.Router();
const MAX_BOARD_BYTES = 450000;

const cleanText = (value) => String(value || '').trim();
const cleanName = (value) => cleanText(value).slice(0, 120);

const requireAssignedCategory = async (user, categoryId) => {
  const id = cleanText(categoryId);
  if (!id) throw Object.assign(new Error('Selecciona una categoría.'), { status: 400 });

  const assignment = await supabase.from('profesor_categorias')
    .select('categoria_id')
    .eq('academia_id', user.academia_id)
    .eq('profesor_id', user.id)
    .eq('categoria_id', id)
    .eq('activo', true)
    .maybeSingle();
  if (assignment.error) throw assignment.error;
  if (!assignment.data) throw Object.assign(new Error('Esta categoría no está asignada a tu perfil.'), { status: 403 });

  const category = await supabase.from('categorias')
    .select('id,nombre,rama_id,sede_id,ramas(id,nombre,disciplina)')
    .eq('academia_id', user.academia_id)
    .eq('id', id)
    .maybeSingle();
  if (category.error) throw category.error;
  if (!category.data) throw Object.assign(new Error('Categoría no encontrada.'), { status: 404 });
  return category.data;
};

const normalizeContent = (value) => {
  const content = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!content) throw Object.assign(new Error('El contenido de la pizarra es inválido.'), { status: 400 });
  const normalized = {
    version: Number(content.version) || 1,
    tokens: Array.isArray(content.tokens) ? content.tokens.slice(0, 80) : [],
    strokes: Array.isArray(content.strokes) ? content.strokes.slice(0, 300) : [],
  };
  const size = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
  if (size > MAX_BOARD_BYTES) throw Object.assign(new Error('La pizarra supera el tamaño permitido. Simplifica algunos trazos.'), { status: 413 });
  return normalized;
};

const getOwnedBoard = async (user, boardId) => {
  const result = await supabase.from('profesor_pizarras')
    .select('*')
    .eq('id', boardId)
    .eq('academia_id', user.academia_id)
    .eq('profesor_id', user.id)
    .maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) throw Object.assign(new Error('Pizarra no encontrada.'), { status: 404 });
  return result.data;
};

const validateAssociation = async (user, categoryId, table, id) => {
  if (!id) return null;
  const result = await supabase.from(table)
    .select('id,categoria_id')
    .eq('id', id)
    .eq('academia_id', user.academia_id)
    .maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) throw Object.assign(new Error('La actividad asociada no existe.'), { status: 404 });
  if (String(result.data.categoria_id || '') !== String(categoryId)) {
    throw Object.assign(new Error('La actividad no pertenece a la categoría de esta pizarra.'), { status: 409 });
  }
  return result.data.id;
};

router.get('/me/pizarras', authMiddleware, requireProfessor, async (req, res) => {
  try {
    let query = supabase.from('profesor_pizarras')
      .select('id,categoria_id,entrenamiento_id,partido_id,nombre,deporte,contenido,created_at,updated_at')
      .eq('academia_id', req.user.academia_id)
      .eq('profesor_id', req.user.id)
      .order('updated_at', { ascending: false })
      .limit(100);

    const categoryId = cleanText(req.query?.categoria_id);
    if (categoryId) {
      await requireAssignedCategory(req.user, categoryId);
      query = query.eq('categoria_id', categoryId);
    }

    const { data, error } = await query;
    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible cargar tus pizarras.' });
  }
});

router.get('/me/pizarras/:boardId', authMiddleware, requireProfessor, async (req, res) => {
  try {
    const board = await getOwnedBoard(req.user, req.params.boardId);
    await requireAssignedCategory(req.user, board.categoria_id);
    return res.json({ success: true, data: board });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible cargar la pizarra.' });
  }
});

router.post('/me/pizarras', authMiddleware, requireProfessor, async (req, res) => {
  try {
    const category = await requireAssignedCategory(req.user, req.body?.categoria_id);
    const name = cleanName(req.body?.nombre) || 'Nueva jugada';
    const content = normalizeContent(req.body?.contenido);
    const trainingId = await validateAssociation(req.user, category.id, 'entrenamientos', cleanText(req.body?.entrenamiento_id));
    const matchId = await validateAssociation(req.user, category.id, 'partidos', cleanText(req.body?.partido_id));
    if (trainingId && matchId) return res.status(400).json({ error: 'Una pizarra no puede asociarse simultáneamente a entrenamiento y partido.' });

    const { data, error } = await supabase.from('profesor_pizarras').insert({
      academia_id: req.user.academia_id,
      profesor_id: req.user.id,
      categoria_id: category.id,
      entrenamiento_id: trainingId,
      partido_id: matchId,
      nombre: name,
      deporte: category.ramas?.disciplina || cleanText(req.body?.deporte) || null,
      contenido: content,
    }).select('*').single();
    if (error) throw error;
    return res.status(201).json({ success: true, message: 'Pizarra guardada.', data });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible guardar la pizarra.' });
  }
});

router.put('/me/pizarras/:boardId', authMiddleware, requireProfessor, async (req, res) => {
  try {
    const board = await getOwnedBoard(req.user, req.params.boardId);
    const category = await requireAssignedCategory(req.user, req.body?.categoria_id || board.categoria_id);
    const name = cleanName(req.body?.nombre) || board.nombre;
    const content = req.body?.contenido === undefined ? board.contenido : normalizeContent(req.body.contenido);
    const trainingRaw = req.body?.entrenamiento_id === undefined ? board.entrenamiento_id : cleanText(req.body.entrenamiento_id);
    const matchRaw = req.body?.partido_id === undefined ? board.partido_id : cleanText(req.body.partido_id);
    const trainingId = await validateAssociation(req.user, category.id, 'entrenamientos', trainingRaw);
    const matchId = await validateAssociation(req.user, category.id, 'partidos', matchRaw);
    if (trainingId && matchId) return res.status(400).json({ error: 'Una pizarra no puede asociarse simultáneamente a entrenamiento y partido.' });

    const { data, error } = await supabase.from('profesor_pizarras').update({
      categoria_id: category.id,
      entrenamiento_id: trainingId,
      partido_id: matchId,
      nombre: name,
      deporte: category.ramas?.disciplina || cleanText(req.body?.deporte) || board.deporte || null,
      contenido: content,
      updated_at: new Date().toISOString(),
    }).eq('id', board.id).eq('academia_id', req.user.academia_id).eq('profesor_id', req.user.id).select('*').single();
    if (error) throw error;
    return res.json({ success: true, message: 'Pizarra actualizada.', data });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible actualizar la pizarra.' });
  }
});

router.delete('/me/pizarras/:boardId', authMiddleware, requireProfessor, async (req, res) => {
  try {
    const board = await getOwnedBoard(req.user, req.params.boardId);
    const { error } = await supabase.from('profesor_pizarras')
      .delete()
      .eq('id', board.id)
      .eq('academia_id', req.user.academia_id)
      .eq('profesor_id', req.user.id);
    if (error) throw error;
    return res.json({ success: true, message: 'Pizarra eliminada.' });
  } catch (error) {
    return res.status(error?.status || 500).json({ error: error?.message || 'No fue posible eliminar la pizarra.' });
  }
});

module.exports = router;
