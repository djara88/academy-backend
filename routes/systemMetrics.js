const express = require('express');
const authMiddleware = require('../middleware/auth');
const { requireSuperadmin } = require('../middleware/authorization');
const { requireSuperadminMfa } = require('../middleware/requireMfa');
const { getMemoryHistory } = require('../services/systemMetrics');

const router = express.Router();
router.use(authMiddleware, requireSuperadmin, requireSuperadminMfa);

router.get('/memory', async (req, res) => {
  try {
    const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours || 24)));
    const data = await getMemoryHistory(hours);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error cargando histórico de memoria:', error?.message || 'Error desconocido');
    res.status(500).json({ error: 'No fue posible cargar el histórico del monitor.' });
  }
});

module.exports = router;
