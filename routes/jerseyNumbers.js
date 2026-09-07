const express = require('express');
const authMiddleware = require('../middleware/auth');
const {
  listJerseyNumbers,
  assignJerseyNumber,
} = require('../services/jerseyNumbers');

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const data = await listJerseyNumbers({
      academyId: req.user.academia_id,
      branchId: req.query?.rama_id,
      categoryId: req.query?.categoria_id || null,
      excludePrematriculaId: req.query?.exclude_prematricula_id || null,
      excludePlayerId: req.query?.exclude_jugador_id || null,
    });
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({
      success: false,
      error: error?.message || 'No fue posible cargar los dorsales.',
      code: error?.code || undefined,
    });
  }
});

router.put('/asignar', async (req, res) => {
  try {
    const player = await assignJerseyNumber({
      academyId: req.user.academia_id,
      playerId: req.body?.jugador_id,
      branchId: req.body?.rama_id,
      categoryId: req.body?.categoria_id || null,
      number: req.body?.numero,
    });
    return res.json({ success: true, data: player });
  } catch (error) {
    return res.status(error?.status || 500).json({
      success: false,
      error: error?.message || 'No fue posible asignar el dorsal.',
      code: error?.code || undefined,
      jersey: error?.jersey || undefined,
    });
  }
});

module.exports = router;
