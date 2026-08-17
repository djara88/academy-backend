const express = require('express');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { requireFeature } = require('../middleware/planAccess');
const { FEATURES } = require('../services/planCatalog');
const {
  loadStudentReportData,
  createStudentReportPdf,
  sendStudentReportEmail,
} = require('../services/studentReport');

const router = express.Router();

router.post('/:id/informe', authMiddleware, requireDirector, ...requireFeature(FEATURES.EXPORTS), async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const branchId = String(req.body?.rama_id || '').trim();
    const comments = String(req.body?.comentarios || '').trim().slice(0, 2500);
    const sendEmail = req.body?.enviar_email === true;

    if (!branchId) return res.status(400).json({ error: 'Selecciona una rama para generar el informe.' });

    const data = await loadStudentReportData({
      academyId,
      playerId: req.params.id,
      branchId,
    });
    const pdfBuffer = await createStudentReportPdf(data, comments);
    const email = sendEmail
      ? await sendStudentReportEmail({ data, pdfBuffer, comments })
      : { sent: false, reason: null };

    return res.json({
      success: true,
      data: {
        filename: `Informe_${String(data.player.nombre || 'Alumno').replace(/[^a-zA-Z0-9_-]+/g, '_')}_${String(data.discipline || 'Deporte').replace(/[^a-zA-Z0-9_-]+/g, '_')}.pdf`,
        pdf_base64: pdfBuffer.toString('base64'),
        email_sent: email.sent,
        email_reason: email.reason,
        discipline: data.discipline,
        branch_id: data.enrollment.rama_id,
      },
    });
  } catch (error) {
    console.error('Error generando informe multirrama:', error?.message || error);
    return res.status(error?.statusCode || 500).json({ error: error?.statusCode ? error.message : 'No fue posible generar el informe del alumno.' });
  }
});

module.exports = router;
