const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const {
  getBranch,
  getTournament,
  listAcademyBranches,
  safeText,
} = require('../services/branchContext');

const router = express.Router();
router.use(authMiddleware);

const isArchived = (tournament) => String(tournament?.estado || '').trim().toLowerCase() === 'archivado';

// Fuente única para las listas visibles: por defecto no devuelve competencias archivadas.
// El Almacén solicita explícitamente ?archivados=true.
router.get('/', async (req, res) => {
  try {
    const branchId = safeText(req.query?.rama_id, 80);
    const archived = String(req.query?.archivados || '').toLowerCase() === 'true';
    let query = supabase.from('torneos')
      .select('*,ramas(id,nombre,disciplina,sede_id),sedes(id,nombre)')
      .eq('academia_id', req.user.academia_id)
      .order('created_at', { ascending: false });

    query = archived ? query.eq('estado', 'Archivado') : query.neq('estado', 'Archivado');
    if (branchId) query = query.eq('rama_id', branchId);

    const [{ data, error }, branches] = await Promise.all([
      query,
      listAcademyBranches(req.user.academia_id),
    ]);
    if (error) throw error;

    return res.json({ success: true, data: data || [], ramas: branches, archivados: archived });
  } catch (error) {
    return res.status(error?.status || 500).json({
      success: false,
      error: error?.message || 'No fue posible cargar las competencias.',
      code: error?.code,
    });
  }
});

// Edición de los datos comerciales/operativos definidos al crear la competencia.
router.patch('/:id', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const tournament = await getTournament(academyId, req.params.id);
    if (isArchived(tournament)) {
      return res.status(409).json({
        success: false,
        error: 'Restaura la competencia desde el Almacén antes de editarla.',
        code: 'TOURNAMENT_ARCHIVED',
      });
    }

    const name = safeText(req.body?.nombre, 180);
    if (!name) return res.status(400).json({ success: false, error: 'El nombre de la competencia es obligatorio.' });

    const branch = await getBranch(academyId, req.body?.rama_id || tournament.rama_id);
    const branchChanged = String(branch.id) !== String(tournament.rama_id || '');
    if (branchChanged) {
      const [{ count: participants, error: participantError }, { count: matches, error: matchError }] = await Promise.all([
        supabase.from('torneo_participantes').select('id', { count: 'exact', head: true }).eq('torneo_id', tournament.id),
        supabase.from('partidos').select('id', { count: 'exact', head: true }).eq('torneo_id', tournament.id),
      ]);
      if (participantError) throw participantError;
      if (matchError) throw matchError;
      if (Number(participants || 0) > 0 || Number(matches || 0) > 0) {
        return res.status(409).json({
          success: false,
          error: 'No se puede cambiar la rama porque esta competencia ya tiene alumnos convocados o eventos registrados.',
          code: 'TOURNAMENT_BRANCH_LOCKED',
        });
      }
    }

    const startDate = req.body?.fecha_inicio || null;
    const endDate = req.body?.fecha_fin || null;
    if (startDate && endDate && String(endDate) < String(startDate)) {
      return res.status(400).json({ success: false, error: 'La fecha de término no puede ser anterior a la fecha de inicio.' });
    }

    const allowsInstallments = req.body?.permite_cuotas === true;
    const changes = {
      sede_id: branch.sede_id,
      rama_id: branch.id,
      nombre: name,
      fecha_inicio: startDate,
      fecha_fin: endDate,
      organizador: safeText(req.body?.organizador, 180) || null,
      ubicacion: safeText(req.body?.ubicacion, 300) || null,
      reglamento_url: safeText(req.body?.reglamento_url, 1000) || null,
      costo_inscripcion: Math.max(0, Number(req.body?.costo_inscripcion) || 0),
      permite_cuotas: allowsInstallments,
      max_cuotas: allowsInstallments ? Math.max(2, Math.min(12, Math.round(Number(req.body?.max_cuotas) || 2))) : 1,
    };

    const { data, error } = await supabase.from('torneos')
      .update(changes)
      .eq('id', tournament.id)
      .eq('academia_id', academyId)
      .select('*,ramas(id,nombre,disciplina,sede_id),sedes(id,nombre)')
      .single();
    if (error) throw error;

    return res.json({ success: true, data, message: 'Competencia actualizada correctamente.' });
  } catch (error) {
    return res.status(error?.status || 500).json({
      success: false,
      error: error?.message || 'No fue posible editar la competencia.',
      code: error?.code,
    });
  }
});

// Archivar no elimina nada: conserva convocatorias, cobros, eventos y resultados para consulta histórica.
router.patch('/:id/archivar', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const tournament = await getTournament(academyId, req.params.id);
    if (isArchived(tournament)) return res.json({ success: true, data: tournament, message: 'La competencia ya estaba archivada.' });

    const { data, error } = await supabase.from('torneos')
      .update({ estado: 'Archivado' })
      .eq('id', tournament.id)
      .eq('academia_id', academyId)
      .select('*,ramas(id,nombre,disciplina,sede_id),sedes(id,nombre)')
      .single();
    if (error) throw error;

    return res.json({ success: true, data, message: 'Competencia enviada al Almacén.' });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible archivar la competencia.' });
  }
});

router.patch('/:id/restaurar', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const tournament = await getTournament(academyId, req.params.id);
    if (!isArchived(tournament)) return res.json({ success: true, data: tournament, message: 'La competencia ya está activa.' });

    const { data, error } = await supabase.from('torneos')
      .update({ estado: 'Activo' })
      .eq('id', tournament.id)
      .eq('academia_id', academyId)
      .select('*,ramas(id,nombre,disciplina,sede_id),sedes(id,nombre)')
      .single();
    if (error) throw error;

    return res.json({ success: true, data, message: 'Competencia restaurada al listado activo.' });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible restaurar la competencia.' });
  }
});

// Evita nuevas convocatorias si alguien conserva un enlace directo a una competencia archivada.
router.post('/:id/convocar', async (req, res, next) => {
  try {
    const tournament = await getTournament(req.user.academia_id, req.params.id);
    if (isArchived(tournament)) {
      return res.status(409).json({
        success: false,
        error: 'Esta competencia está archivada. Restáurala antes de enviar nuevas convocatorias.',
        code: 'TOURNAMENT_ARCHIVED',
      });
    }
    return next();
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error?.message || 'No fue posible validar la competencia.' });
  }
});

module.exports = router;
