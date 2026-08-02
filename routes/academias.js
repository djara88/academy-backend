const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

// 1. OBTENER TODAS LAS ACADEMIAS
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('academias')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error al obtener academias:', error);
    return res.status(500).json({ error: 'Error de Supabase' });
  }

  res.json(data || []);
});

// 2. CREAR NUEVA ACADEMIA
router.post('/', upload.single('logo'), async (req, res) => {
  const { 
    nombre, direccion, telefono, correo_academia, 
    nombre_director, director_email, plan 
  } = req.body;

  try {
    let logoUrl = null;

    if (req.file) {
      const fileName = `${Date.now()}_${req.file.originalname.replace(/\s+/g, '_')}`;
      const { error: uploadError } = await supabase.storage
        .from('logos-escuelas')
        .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });

      if (uploadError) throw new Error('No se pudo subir el logo al servidor.');

      const { data: publicUrlData } = supabase.storage.from('logos-escuelas').getPublicUrl(fileName);
      logoUrl = publicUrlData.publicUrl;
    }

    const { data: nuevaAcademia, error: dbError } = await supabase
      .from('academias')
      .insert([{ 
        nombre, logo: logoUrl, direccion, telefono, correo_academia,
        nombre_director, director_email, plan, estado: 'Activa', jugadores_count: 0
      }])
      .select().single();

    if (dbError) throw dbError;

    const tempPassword = Math.random().toString(36).substring(2, 10) + "A1!"; 
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email: director_email,
      password: tempPassword,
    });

    if (!authError && authData?.user) {
      await supabase.from('usuarios').insert([{
        id: authData.user.id,
        academia_id: nuevaAcademia.id,
        nombre_completo: nombre_director,
        rol: 'director'
      }]);
    }

    const brevoApiKey = process.env.BREVO_API_KEY;
    if (brevoApiKey) {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'accept': 'application/json', 'api-key': brevoApiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          sender: { name: "AcademiaPro", email: "no-reply@academiapro.com" },
          to: [{ email: director_email }],
          subject: "¡Bienvenido a AcademiaPro! Tus credenciales de acceso",
          htmlContent: `
            <h2>¡Hola ${nombre_director}!</h2>
            <p>Tu academia <strong>${nombre}</strong> ha sido registrada.</p>
            <p><strong>Usuario:</strong> ${director_email}<br/><strong>Contraseña:</strong> ${tempPassword}</p>
          `
        })
      });
    }

    res.status(201).json(nuevaAcademia);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Error interno' });
  }
});

// 3. ACTUALIZAR ACADEMIA (EDITAR)
router.put('/:id', upload.single('logo'), async (req, res) => {
  const { id } = req.params;
  const { nombre, direccion, telefono, correo_academia, nombre_director, director_email, plan, estado } = req.body;

  try {
    let updateData = { nombre, direccion, telefono, correo_academia, nombre_director, director_email, plan, estado };

    if (req.file) {
      const fileName = `${Date.now()}_${req.file.originalname.replace(/\s+/g, '_')}`;
      const { error: uploadError } = await supabase.storage
        .from('logos-escuelas')
        .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });

      if (uploadError) throw new Error('No se pudo subir el nuevo logo.');

      const { data: publicUrlData } = supabase.storage.from('logos-escuelas').getPublicUrl(fileName);
      updateData.logo = publicUrlData.publicUrl;
    }

    const { data, error } = await supabase
      .from('academias')
      .update(updateData)
      .eq('id', id)
      .select().single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Error al actualizar academia' });
  }
});

// 4. ELIMINAR ACADEMIA
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // Al borrar la academia, debes asegurarte en Supabase de tener "ON DELETE CASCADE" 
    // en tus otras tablas para que borre a los usuarios y jugadores asociados.
    const { error } = await supabase.from('academias').delete().eq('id', id);
    if (error) throw error;
    res.json({ message: 'Academia eliminada exitosamente' });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Error al eliminar academia' });
  }
});

// 5. RESTABLECER CONTRASEÑA DEL DIRECTOR
router.post('/:id/reset-password', async (req, res) => {
  const { id } = req.params;
  
  try {
    // 1. Obtener la academia para saber el email del director
    const { data: academia, error: acaError } = await supabase.from('academias').select('director_email, nombre, nombre_director').eq('id', id).single();
    if (acaError || !academia) throw new Error('Academia no encontrada');

    // 2. Generar nueva clave
    const newPassword = Math.random().toString(36).substring(2, 10) + "X9#"; 

    // 3. Usar Supabase Admin API para forzar el cambio de clave (requiere SERVICE_ROLE key en el backend idealmente, o signUp trick si está permitido)
    // Para simplificar y no depender del service_role, usamos el método de recuperar clave si está configurado, 
    // pero como somos SuperAdmin, actualizamos la clave directamente llamando al auth.admin (Asegúrate de que tu supabase.js use la SERVICE_ROLE_KEY)
    
    // NOTA: Para que esto funcione 100%, la variable SUPABASE_KEY de tu Render debe ser la "service_role secret", no la "anon public".
    const { data: userData, error: userError } = await supabase.from('usuarios').select('id').eq('academia_id', id).eq('rol', 'director').single();
    
    if (userData && userData.id) {
      const { error: updateError } = await supabase.auth.admin.updateUserById(userData.id, { password: newPassword });
      if (updateError) throw updateError;
    } else {
      throw new Error('No se encontró el usuario director asociado a esta academia.');
    }

    // 4. Enviar correo por Brevo
    const brevoApiKey = process.env.BREVO_API_KEY;
    if (brevoApiKey) {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'accept': 'application/json', 'api-key': brevoApiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          sender: { name: "Soporte AcademiaPro", email: "no-reply@academiapro.com" },
          to: [{ email: academia.director_email }],
          subject: "Restablecimiento de Contraseña - AcademiaPro",
          htmlContent: `
            <h2>Hola ${academia.nombre_director},</h2>
            <p>El administrador del sistema ha restablecido la contraseña de tu academia <strong>${academia.nombre}</strong>.</p>
            <p><strong>Tu nueva contraseña temporal es:</strong> ${newPassword}</p>
            <p>Por favor, inicia sesión y cámbiala lo antes posible.</p>
          `
        })
      });
    }

    res.json({ message: 'Contraseña restablecida y enviada por correo' });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Error al restablecer contraseña' });
  }
});

module.exports = router;
