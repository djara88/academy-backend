const express = require('express');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { buildSetupStatus, updateSetupPreferences } = require('../services/academySetupService');

const router = express.Router();
router.use(authMiddleware, requireDirector);

router.get('/', async (req, res) => {
  try {
    const data = await buildSetupStatus(req.user.academia_id);
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error cargando Puesta en Marcha:', error?.message || error);
    return res.status(500).json({ success: false, error: 'No fue posible revisar la Puesta en Marcha de la academia.' });
  }
});

router.put('/preferencias', async (req, res) => {
  try {
    await updateSetupPreferences(req.user.academia_id, req.body || {});
    const data = await buildSetupStatus(req.user.academia_id);
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error?.status || 500).json({
      success: false,
      error: error?.message || 'No fue posible guardar la configuración inicial.',
      code: error?.code || undefined,
    });
  }
});

router.post('/revisar', async (req, res) => {
  try {
    const data = await buildSetupStatus(req.user.academia_id);
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'No fue posible validar la configuración de la academia.' });
  }
});

module.exports = router;