const express = require('express');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { getCategoryContext, getStudentsForScope, safeText } = require('../services/branchContext');

const router = express.Router();
router.use(authMiddleware, requireDirector);

const documentOf = (student) => student.rut || student.rut_pasaporte || student.numero_documento || null;
const photoOf = (student) => student.foto_base64 || student.foto_url || student.avatar_url || null;

router.get('/alumnos', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const branchId = safeText(req.query?.rama_id, 80);
    const categoryId = safeText(req.query?.categoria_id, 80);
    if (!branchId || !categoryId) {
      return res.status(400).json({ success: false, error: 'Selecciona una rama y categoría para cargar la lista.' });
    }

    const { category } = await getCategoryContext(academyId, categoryId);
    if (String(category.rama_id) !== String(branchId)) {
      return res.status(409).json({ success: false, code: 'CATEGORY_BRANCH_MISMATCH', error: 'La categoría no pertenece a la rama seleccionada.' });
    }

    // La pertenencia a categoría se resuelve mediante jugador_categoria. El
    // categoria_id de la inscripción es solo una referencia histórica y no se
    // utiliza para excluir alumnos de sus categorías adicionales.
    const students = await getStudentsForScope({
      academyId,
      branchId,
      categoryId,
      playerSelect: 'id,nombre,rut,rut_pasaporte,numero_documento,fecha_nacimiento,foto_base64,foto_url,avatar_url,alerta_medica',
    });

    const data = students.map((student) => ({
      id: student.id,
      nombre: student.nombre,
      documento: documentOf(student),
      fecha_nacimiento: student.fecha_nacimiento || null,
      foto: photoOf(student),
      rol_especialidad: student.inscripcion?.rol_especialidad || null,
      inscripcion_id: student.inscripcion?.id || null,
      rama_id: student.inscripcion?.rama_id || branchId,
      tiene_alerta_medica: Boolean(String(student.alerta_medica || '').trim()),
    }));

    return res.json({
      success: true,
      data,
      meta: {
        rama_id: branchId,
        categoria_id: categoryId,
        total: data.length,
      },
    });
  } catch (error) {
    console.error('Error cargando roster de asistencia:', error?.message || error);
    return res.status(error?.status || 500).json({
      success: false,
      code: error?.code || undefined,
      error: error?.message || 'No fue posible cargar la lista de asistencia.',
    });
  }
});

module.exports = router;
