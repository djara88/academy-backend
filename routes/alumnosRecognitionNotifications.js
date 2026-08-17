const express = require('express');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { notifyRecognitionWhatsapp } = require('../services/recognitionWhatsapp');

const router = express.Router();

// Middleware de compatibilidad: el nuevo flujo multirrama guarda los reconocimientos
// en /api/alumnos, mientras el flujo histórico que enviaba WhatsApp vivía en
// /api/jugadores/:id/datos-rapidos. Escuchamos únicamente respuestas exitosas del
// endpoint nuevo para conservar esa automatización sin duplicar la lógica deportiva.
router.post('/:id/reconocimientos', authMiddleware, requireDirector, (req, res, next) => {
  const academyId = req.user?.academia_id;
  const playerId = req.params.id;
  const recognitionCode = String(req.body?.recognition_code || '').trim();
  const branchId = String(req.body?.rama_id || '').trim();

  res.once('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    void notifyRecognitionWhatsapp({ academyId, playerId, recognitionCode, branchId })
      .then((result) => {
        if (result?.sent) console.log(`✅ WhatsApp de reconocimiento enviado para alumno ${playerId}`);
        else console.log(`ℹ️ WhatsApp de reconocimiento omitido para alumno ${playerId}: ${result?.reason || 'sin detalle'}`);
      })
      .catch((error) => {
        // La medalla ya fue otorgada. Un problema externo de WhatsApp no debe revertir
        // ni convertir en error la operación deportiva principal.
        console.error('❌ Error enviando WhatsApp de reconocimiento:', error?.message || error);
      });
  });

  return next();
});

module.exports = router;
