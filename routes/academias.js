const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');

// 1. OBTENER TODAS LAS ACADEMIAS (Para llenar la tabla del SaaSAdmin)
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('academias')
    .select('*')
    .order('created_at', { ascending: false }); // 🔥 CORREGIDO A 'created_at'

  if (error) {
    console.error('Error al obtener academias:', error);
    return res.status(500).json({ error: 'Error al obtener academias de Supabase' });
  }

  res.json(data || []);
});

// 2. CREAR NUEVA ACADEMIA Y ENVIAR CORREO CON BREVO
router.post('/', async (req, res) => {
  const { nombre, director_email, plan } = req.body;

  try {
    // A) Guardar en Supabase PostgreSQL
    const { data: nuevaAcademia, error: dbError } = await supabase
      .from('academias')
      .insert([{ 
        nombre, 
        director_email, 
        plan, 
        estado: 'Activa',
        jugadores_count: 0
      }])
      .select()
      .single();

    if (dbError) throw dbError;

    // B) Disparar correo de bienvenida con Brevo
    const brevoApiKey = process.env.BREVO_API_KEY;
    
    if (brevoApiKey) {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'api-key': brevoApiKey,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          sender: { name: "AcademiaPro", email: "no-reply@academiapro.com" }, // Cambia por tu remitente oficial de Brevo
          to: [{ email: director_email }],
          subject: "¡Bienvenido a AcademiaPro! Tu plataforma está lista",
          htmlContent: `
            <h2>¡Hola! Bienvenido a AcademiaPro</h2>
            <p>Tu academia <strong>${nombre}</strong> ha sido registrada exitosamente con el plan <strong>${plan}</strong>.</p>
            <p>Ya puedes acceder a la plataforma para comenzar a gestionar tus jugadores y torneos.</p>
            <br/>
            <p>Saludos,<br/>El equipo de AcademiaPro</p>
          `
        })
      });
      console.log(`✅ Correo enviado a ${director_email} mediante Brevo.`);
    } else {
      console.warn("⚠️ No se encontró BREVO_API_KEY en el entorno. La academia se guardó, pero no se envió el correo.");
    }

    // Responder al Frontend que todo fue un éxito
    res.status(201).json(nuevaAcademia);

  } catch (error) {
    console.error('❌ Error al crear academia:', error);
    res.status(500).json({ error: error.message || 'Error interno del servidor' });
  }
});

module.exports = router;
