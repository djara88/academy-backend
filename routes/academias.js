const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const multer = require('multer');

// Configuración de Multer para guardar el archivo temporalmente en memoria
const upload = multer({ storage: multer.memoryStorage() });

// 1. OBTENER TODAS LAS ACADEMIAS
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('academias')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error al obtener academias:', error);
    return res.status(500).json({ error: 'Error al obtener academias de Supabase' });
  }

  res.json(data || []);
});

// 2. CREAR NUEVA ACADEMIA (CON SUBIDA DE LOGO) Y ENVIAR CORREO
// Usamos upload.single('logo') para interceptar el archivo que viene desde el Frontend
router.post('/', upload.single('logo'), async (req, res) => {
  const { 
    nombre, 
    direccion, 
    telefono, 
    correo_academia, 
    nombre_director, 
    director_email, 
    plan 
  } = req.body;

  try {
    let logoUrl = null;

    // A) Si el usuario subió un archivo, lo subimos al Storage de Supabase
    if (req.file) {
      // Limpiamos el nombre del archivo para evitar errores en URLs (quitamos espacios)
      const fileName = `${Date.now()}_${req.file.originalname.replace(/\s+/g, '_')}`;
      
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('logos-escuelas') // Tu bucket
        .upload(fileName, req.file.buffer, {
          contentType: req.file.mimetype,
        });

      if (uploadError) {
        console.error('Error de Storage:', uploadError);
        throw new Error('No se pudo subir el logo al servidor.');
      }

      // Obtenemos la URL pública del archivo recién subido
      const { data: publicUrlData } = supabase.storage
        .from('logos-escuelas')
        .getPublicUrl(fileName);

      logoUrl = publicUrlData.publicUrl;
    }

    // B) Guardar en Supabase PostgreSQL (ahora con la URL real del bucket)
    const { data: nuevaAcademia, error: dbError } = await supabase
      .from('academias')
      .insert([{ 
        nombre, 
        logo: logoUrl, // Se guarda la URL de Supabase Storage o null si no subió logo
        direccion,
        telefono,
        correo_academia,
        nombre_director,
        director_email, 
        plan, 
        estado: 'Activa',
        jugadores_count: 0
      }])
      .select()
      .single();

    if (dbError) throw dbError;

    // C) Disparar correo de bienvenida con Brevo
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
          sender: { name: "AcademiaPro", email: "no-reply@academiapro.com" },
          to: [{ email: director_email }],
          subject: "¡Bienvenido a AcademiaPro! Tu plataforma está lista",
          htmlContent: `
            <h2>¡Hola ${nombre_director}! Bienvenido a AcademiaPro</h2>
            <p>Tu academia <strong>${nombre}</strong> ha sido registrada exitosamente con el plan <strong>${plan}</strong>.</p>
            <p>Ya puedes acceder a la plataforma para comenzar a gestionar tus jugadores y torneos.</p>
            <br/>
            <p>Saludos,<br/>El equipo de AcademiaPro</p>
          `
        })
      });
      console.log(`✅ Correo enviado a ${director_email} mediante Brevo.`);
    } else {
      console.warn("⚠️ No se encontró BREVO_API_KEY en el entorno. La academia se guardó sin enviar correo.");
    }

    res.status(201).json(nuevaAcademia);

  } catch (error) {
    console.error('❌ Error al crear academia:', error);
    res.status(500).json({ error: error.message || 'Error interno del servidor' });
  }
});

module.exports = router;
