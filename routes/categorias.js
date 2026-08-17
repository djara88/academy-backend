const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { getStudentEnrollment } = require('../services/branchContext');

const router = express.Router();

const safeText = (value, max = 180) => String(value ?? '').trim().slice(0, max);

const getAcademyBranches = async (academyId) => {
  const { data, error } = await supabase
    .from('ramas')
    .select('id,sede_id,nombre,disciplina,principal,activa,sedes(id,nombre,principal,activa)')
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
    .select('id,academia_id,nombre,descripcion,sede_id,rama_id,ramas(id,nombre,disciplina),sedes(id,nombre)')
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

const getPlayer = async (academyId, playerId) => {
  const { data, error } = await supabase
    .from('jugadores')
    .select('id,sede_id,rama_id,categoria_id')
    .eq('id', playerId)
    .eq('academia_id', academyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const notFound = new Error('Alumno no encontrado.');
    notFound.status = 404;
    throw notFound;
  }
  return data;
};

const getBranchMemberships = async (playerId, branchId) => {
  const { data, error } = await supabase
    .from('jugador_categoria')
    .select('categoria_id,categorias(id,nombre,sede_id,rama_id)')
    .eq('jugador_id', playerId);
  if (error) throw error;
  return (data || [])
    .map((row) => row.categorias)
    .filter((category) => category && String(category.rama_id) === String(branchId))
    .sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es'));
};

const syncReferenceCategory = async ({ academyId, player, enrollment, preferredCategoryId }) => {
  const value = preferredCategoryId || null;
  const { data: updatedEnrollment, error } = await supabase
    .from('inscripciones_deportivas')
    .update({ categoria_id: value, updated_at: new Date().toISOString() })
    .eq('id', enrollment.id)
    .eq('academia_id', academyId)
    .select('id,jugador_id,sede_id,rama_id,categoria_id,estado,es_principal')
    .single();
  if (error) throw error;

  // Compatibilidad con pantallas históricas: los campos de jugadores reflejan
  // únicamente la inscripción principal y una categoría de referencia. La
  // pertenencia real a varias categorías vive en jugador_categoria.
  if (updatedEnrollment.es_principal) {
    const { error: updateError } = await supabase.from('jugadores')
      .update({
        sede_id: updatedEnrollment.sede_id,
        rama_id: updatedEnrollment.rama_id,
        categoria_id: value,
      })
      .eq('id', player.id)
      .eq('academia_id', academyId);
    if (updateError) throw updateError;
  }
  return updatedEnrollment;
};

const listCategories = async (req, res) => {
  try {
    const branchId = safeText(req.query?.rama_id, 80);
    let query = supabase
      .from('categorias')
      .select('id,nombre,descripcion,sede_id,rama_id,created_at,ramas(id,nombre,disciplina),sedes(id,nombre)')
      .eq('academia_id', req.user.academia_id)
      .order('created_at', { ascending: true });
    if (branchId) query = query.eq('rama_id', branchId);
    const { data, error } = await query;
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
      .select('id,nombre,descripcion,sede_id,rama_id,created_at,ramas(id,nombre,disciplina),sedes(id,nombre)')
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
      return res.status(400).json({ success: false, error: 'Alumno y categoría son obligatorios.' });
    }

    const category = await getCategory(academyId, categoryId);
    if (!category.rama_id || !category.sede_id) {
      return res.status(409).json({
        success: false,
        error: 'La categoría debe estar asociada a una sede y rama antes de asignar alumnos.',
        code: 'CATEGORY_NOT_SCOPED',
      });
    }

    const player = await getPlayer(academyId, playerId);
    const enrollment = await getStudentEnrollment(academyId, player.id, { branchId: category.rama_id });

    // Asignación aditiva: nunca se elimina una categoría anterior al agregar otra.
    const { error: relationError } = await supabase
      .from('jugador_categoria')
      .upsert([{ jugador_id: player.id, categoria_id: category.id }], { onConflict: 'jugador_id,categoria_id', ignoreDuplicates: true });
    if (relationError) throw relationError;

    let updatedEnrollment = enrollment;
    if (!enrollment.categoria_id) {
      updatedEnrollment = await syncReferenceCategory({
        academyId,
        player,
        enrollment,
        preferredCategoryId: category.id,
      });
    } else if (enrollment.es_principal && (String(player.rama_id || '') !== String(enrollment.rama_id) || String(player.sede_id || '') !== String(enrollment.sede_id))) {
      // Corrige únicamente la proyección legacy sin tocar la categoría de referencia existente.
      const { error: updateError } = await supabase.from('jugadores')
        .update({ sede_id: enrollment.sede_id, rama_id: enrollment.rama_id, categoria_id: enrollment.categoria_id })
        .eq('id', player.id)
        .eq('academia_id', academyId);
      if (updateError) throw updateError;
    }

    const categories = await getBranchMemberships(player.id, category.rama_id);
    return res.status(200).json({
      success: true,
      data: {
        category,
        enrollment: updatedEnrollment,
        categorias: categories,
        categoria_referencia_id: updatedEnrollment.categoria_id || null,
      },
    });
  } catch (error) {
    res.status(error?.status || 500).json({
      success: false,
      error: error?.message || 'No fue posible asignar la categoría.',
      code: error?.code || undefined,
    });
  }
};

const removePlayer = async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const categoryId = safeText(req.params.categoryId, 80);
    const playerId = safeText(req.params.playerId, 80);
    if (!categoryId || !playerId) {
      return res.status(400).json({ success: false, error: 'Alumno y categoría son obligatorios.' });
    }

    const category = await getCategory(academyId, categoryId);
    if (!category.rama_id) return res.status(409).json({ success: false, error: 'La categoría no tiene una rama válida.' });
    const player = await getPlayer(academyId, playerId);
    const enrollment = await getStudentEnrollment(academyId, player.id, { branchId: category.rama_id });

    const { error: relationError } = await supabase.from('jugador_categoria')
      .delete()
      .eq('jugador_id', player.id)
      .eq('categoria_id', category.id);
    if (relationError) throw relationError;

    const remaining = await getBranchMemberships(player.id, category.rama_id);
    const referenceStillExists = remaining.some((item) => String(item.id) === String(enrollment.categoria_id || ''));
    let updatedEnrollment = enrollment;
    if (!referenceStillExists) {
      updatedEnrollment = await syncReferenceCategory({
        academyId,
        player,
        enrollment,
        preferredCategoryId: remaining[0]?.id || null,
      });
    }

    return res.json({
      success: true,
      data: {
        removed_category_id: category.id,
        enrollment: updatedEnrollment,
        categorias: remaining,
        categoria_referencia_id: updatedEnrollment.categoria_id || null,
      },
    });
  } catch (error) {
    return res.status(error?.status || 500).json({
      success: false,
      error: error?.message || 'No fue posible quitar la categoría.',
      code: error?.code || undefined,
    });
  }
};

router.get(['/categorias', '/jugadores/categorias'], authMiddleware, listCategories);
router.post(['/categorias', '/jugadores/categorias'], authMiddleware, requireDirector, createCategory);
router.post(['/categorias/:categoryId/jugadores/:playerId', '/jugadores/:playerId/categorias'], authMiddleware, requireDirector, assignPlayer);
router.delete(['/categorias/:categoryId/jugadores/:playerId', '/jugadores/:playerId/categorias/:categoryId'], authMiddleware, requireDirector, removePlayer);

module.exports = router;
