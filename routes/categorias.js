const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');

const router = express.Router();
router.use(authMiddleware);

const safeText = (value, max = 180) => String(value ?? '').trim().slice(0, max);

const getAcademyBranches = async (academyId) => {
  const { data, error } = await supabase
    .from('ramas')
    .select('id,sede_id,nombre,disciplina,principal,activa')
    .eq('academia_id', academyId)
    .eq('activa', true)
    .order('principal', { ascending: false })
    .order('nombre');
  if (error) throw error;
  return data || [];
};

const resolveBranch = async (academyId, requestedBranchId) => {
  const branchId = safeText(requestedBranchId, 80);
  const branches = await getAcademyBranches(academyId);

  if (branchId) {
    const branch = branches.find((item) => item.id === branchId);
    if (!branch) {
      const error = new Error('La rama seleccionada no pertenece a la academia o está inactiva.');
      error.status = 400;
      error.code = 'INVALID_BRANCH';
      throw error;
    }
    return { branch, branches };
  }

  if (branches.length === 1) return { branch: branches[0], branches };

  const error = new Error(branches.length === 0
    ? 'Crea una sede y una rama deportiva antes de crear categorías.'
    : 'Selecciona la rama deportiva a la que pertenece la categoría.');
  error.status = 400;
  error.code = 'BRANCH_REQUIRED';
  error.availableBranches = branches;
  throw error;
};

const getCategory = async (academyId, categoryId) => {
  const { data, error } = await supabase
    .from('categorias')
    .select('id,academia_id,nombre,descripcion,sede_id,rama_id')
    .eq('id', categoryId)
    .eq('academia_id', academyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const notFound = new Error('Categoría no encontrada.');
    notFound.status = 404;
    throw notFound;
  }
  return data;
};

const listCategories = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('categorias')
      .select('id,nombre,descripcion,sede_id,rama_id,created_at')
      .eq('academia_id', req.user.academia_id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (_error) {
    res.status(500).json({ success: false, error: 'No fue posible cargar las categorías.' });
  }
};

const createCategory = async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const nombre = safeText(req.body?.nombre);
    const descripcion = safeText(req.body?.descripcion, 500) || null;
    if (!nombre) return res.status(400).json({ success: false, error: 'El nombre de la categoría es obligatorio.' });

    const { branch } = await resolveBranch(academyId, req.body?.rama_id);
    const { data, error } = await supabase
      .from('categorias')
      .insert([{
        academia_id: academyId,
        nombre,
        descripcion,
        sede_id: branch.sede_id,
        rama_id: branch.id,
      }])
      .select('id,nombre,descripcion,sede_id,rama_id,created_at')
      .single();
    if (error) throw error;

    res.status(201).json({ success: true, data });
  } catch (error) {
    const duplicate = error?.code === '23505';
    res.status(error?.status || (duplicate ? 409 : 500)).json({
      success: false,
      error: duplicate ? 'Ya existe una categoría con ese nombre en la rama.' : error?.message || 'No fue posible crear la categoría.',
      code: error?.code || undefined,
      availableBranches: error?.availableBranches || undefined,
    });
  }
};

const assignPlayer = async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const categoryId = safeText(req.params.categoryId || req.body?.categoria_id, 80);
    const playerId = safeText(req.params.playerId, 80);
    if (!categoryId || !playerId) {
      return res.status(400).json({ success: false, error: 'Deportista y categoría son obligatorios.' });
    }

    const category = await getCategory(academyId, categoryId);
    if (!category.rama_id || !category.sede_id) {
      return res.status(409).json({
        success: false,
        error: 'La categoría debe estar asociada a una sede y rama antes de asignar deportistas.',
        code: 'CATEGORY_NOT_SCOPED',
      });
    }

    const { data: player, error: playerError } = await supabase
      .from('jugadores')
      .select('id,sede_id,rama_id')
      .eq('id', playerId)
      .eq('academia_id', academyId)
      .maybeSingle();
    if (playerError) throw playerError;
    if (!player) return res.status(404).json({ success: false, error: 'Deportista no encontrado.' });

    if (player.rama_id && player.rama_id !== category.rama_id) {
      return res.status(409).json({
        success: false,
        error: 'El deportista ya pertenece a otra rama deportiva. Cambia su rama antes de asignar esta categoría.',
        code: 'PLAYER_BRANCH_CONFLICT',
      });
    }

    const { error: relationError } = await supabase
      .from('jugador_categoria')
      .upsert([{ jugador_id: player.id, categoria_id: category.id }], { onConflict: 'jugador_id,categoria_id', ignoreDuplicates: true });
    if (relationError) throw relationError;

    const { data: updatedPlayer, error: updateError } = await supabase
      .from('jugadores')
      .update({ sede_id: category.sede_id, rama_id: category.rama_id })
      .eq('id', player.id)
      .eq('academia_id', academyId)
      .select('id,sede_id,rama_id')
      .single();
    if (updateError) throw updateError;

    res.status(201).json({ success: true, data: { category, player: updatedPlayer } });
  } catch (error) {
    res.status(error?.status || 500).json({
      success: false,
      error: error?.message || 'No fue posible asignar la categoría.',
      code: error?.code || undefined,
    });
  }
};

router.get(['/categorias', '/jugadores/categorias'], listCategories);
router.post(['/categorias', '/jugadores/categorias'], requireDirector, createCategory);
router.post(['/categorias/:categoryId/jugadores/:playerId', '/jugadores/:playerId/categorias'], requireDirector, assignPlayer);

module.exports = router;
