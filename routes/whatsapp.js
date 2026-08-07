// routes/whatsapp.js

const express = require('express');
const router = express.Router();
const { conectarAcademia, enviarMensaje } = require('../services/whatsappService');

// Ruta para consultar estado / obtener QR
router.get('/estado/:academiaId', async (req, res) => {
  const { academiaId } = req.params;

  try {
    const data = await conectarAcademia(academiaId);
    
    if (data?.instance?.state === 'open' || data?.state === 'open') {
      return res.json({ conectado: true, mensaje: 'WhatsApp ya está conectado' });
    }

    if (data?.qrcode?.base64 || data?.base64) {
      return res.json({ 
        conectado: false, 
        qrCode: data.qrcode?.base64 || data.base64 
      });
    }

    res.json({ conectado: false, estado: 'Iniciando...', data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Ruta para enviar mensaje
router.post('/enviar/:academiaId', async (req, res) => {
  const { academiaId } = req.params;
  const { numero, mensaje } = req.body;

  if (!numero || !mensaje) {
    return res.status(400).json({ error: 'Faltan el número o el mensaje' });
  }

  try {
    const resultado = await enviarMensaje(academiaId, numero, mensaje);
    res.json({ success: true, resultado });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
