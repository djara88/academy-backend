const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const multer = require('multer');

// Configuración de Multer para guardar archivos temporalmente en memoria
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

// 2. CREAR NUEVA ACADEMIA Y CREAR USUARIO DIRECTOR
router.post('/', upload.single('logo'), async (req, res) => {
  const { 
    nombre, direccion, telefono, correo_academia, 
    nombre_director, director_email, plan 
  } = req.body;

  let createdAuthUser = null;

  try {
    // A) Generar clave temporal
    const tempPassword = Math.random().toString(36).substring(2, 10) + "A1!"; 

    // B) CREAR USUARIO EN SUPABASE AUTH COMO ADMIN (Valida si ya existe antes de continuar)
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: director_email,
      password: tempPassword,
      email_confirm: true // Confirmado automáticamente
    });

    if (authError) {
      if (authError.code === 'user_already_exists' || authError.status === 422) {
        return res.status(400).json({ 
          error: `El correo "${director_email}" ya está registrado en el sistema. Utiliza un correo distinto o elimínalo desde el panel de Supabase.` 
        });
      }
      throw authError;
    }

    createdAuthUser = authData.user;

    // C) Subir logo al bucket Storage si fue adjuntado
    let logoUrl = null;
    if (req.file) {
      const fileName = `${Date.now()}_${req.file.originalname.replace(/\s+/g, '_')}`;
      const { error: uploadError } = await supabase.storage
        .from('logos-escuelas')
        .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });

      if (uploadError) throw new Error('No se pudo subir el logo al servidor.');

      const { data: publicUrlData } = supabase.storage
        .from('logos-escuelas')
        .getPublicUrl(fileName);

      logoUrl = publicUrlData.publicUrl;
    }

    // D) Guardar academia en la base de datos
    const { data: nuevaAcademia, error: dbError } = await supabase
      .from('academias')
      .insert([{ 
        nombre, logo: logoUrl, direccion, telefono, correo_academia,
        nombre_director, director_email, plan, estado: 'Activa', jugadores_count: 0
      }])
      .select()
      .single();

    if (dbError) throw dbError;

    // E) Vincular al director con su academia en la tabla 'usuarios'
    const { error: userTableError } = await supabase.from('usuarios').insert([{
      id: createdAuthUser.id,
      academia_id: nuevaAcademia.id,
      nombre_completo: nombre_director,
      rol: 'director'
    }]);

    if (userTableError) {
      console.error("⚠️ Error vinculando usuario en tabla 'usuarios':", userTableError);
    }

    // F) Enviar correo por Brevo usando BREVO_SENDER_EMAIL
    const brevoApiKey = process.env.BREVO_API_KEY;
    const brevoSenderEmail = process.env.BREVO_SENDER_EMAIL;

    if (brevoApiKey && brevoSenderEmail) {
      try {
        const brevoResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'accept': 'application/json',
            'api-key': brevoApiKey,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            sender: { name: "AcademiaPro", email: brevoSenderEmail },
            to: [{ email: director_email }],
            subject: "¡Bienvenido a AcademiaPro! Tus credenciales de acceso",
            htmlContent: `
              <div style="font-family: sans-serif; color: #333;">
                <h2>¡Hola ${nombre_director}! Bienvenido a AcademiaPro</h2>
                <p>Tu academia <strong>${nombre}</strong> ha sido registrada exitosamente con el plan <strong>${plan}</strong>.</p>
                
                <div style="background-color: #f4f4f4; padding: 15px; border-radius: 8px; margin: 20px 0;">
                  <h3 style="margin-top:0;">Tus credenciales de acceso:</h3>
                  <p><strong>Usuario:</strong> ${director_email}</p>
                  <p><strong>Contraseña temporal:</strong> ${tempPassword}</p>
                </div>

                <p>Te recomendamos iniciar sesión y cambiar esta contraseña lo antes posible por motivos de seguridad.</p>
                <br/>
                <p>Saludos,<br/>El equipo de AcademiaPro</p>
              </div>
            `
          })
        });

        if (!brevoResponse.ok) {
          const errorData = await brevoResponse.json();
          console.error(`❌ Brevo rechazó el correo:`, errorData);
        } else {
          console.log(`✅ Correo y clave enviados exitosamente a ${director_email}`);
        }
      } catch (fetchError) {
        console.error(`❌ Error de conexión con Brevo:`, fetchError);
      }
    } else {
      console.warn("⚠️ Falta BREVO_API_KEY o BREVO_SENDER_EMAIL en Render. No se envió el correo.");
    }

    res.status(201).json(nuevaAcademia);

  } catch (error) {
    console.error('❌ Error al crear academia:', error);

    // Si falló la creación de la academia pero alcanzamos a crear el usuario en Auth, lo limpiamos
    if (createdAuthUser) {
      await supabase.auth.admin.deleteUser(createdAuthUser.id);
    }

    res.status(500).json({ error: error.message || 'Error interno del servidor' });
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
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('❌ Error al actualizar academia:', error);
    res.status(500).json({ error: error.message || 'Error al actualizar academia' });
  }
});

// 4. ELIMINAR ACADEMIA
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabase.from('academias').delete().eq('id', id);
    if (error) throw error;
    res.json({ message: 'Academia eliminada exitosamente' });
  } catch (error) {
    console.error('❌ Error al eliminar academia:', error);
    res.status(500).json({ error: error.message || 'Error al eliminar academia' });
  }
});

// 5. RESTABLECER CONTRASEÑA DEL DIRECTOR
router.post('/:id/reset-password', async (req, res) => {
  const { id } = req.params;
  
  try {
    const { data: academia, error: acaError } = await supabase
      .from('academias')
      .select('director_email, nombre, nombre_director')
      .eq('id', id)
      .single();

    if (acaError || !academia) throw new Error('Academia no encontrada');

    const newPassword = Math.random().toString(36).substring(2, 10) + "X9#"; 

    const { data: userData, error: userError } = await supabase
      .from('usuarios')
      .select('id')
      .eq('academia_id', id)
      .eq('rol', 'director')
      .single();
    
    if (userData && userData.id) {
      const { error: updateError } = await supabase.auth.admin.updateUserById(userData.id, { password: newPassword });
      if (updateError) throw updateError;
    } else {
      throw new Error('No se encontró el usuario director asociado a esta academia.');
    }

    const brevoApiKey = process.env.BREVO_API_KEY;
    const brevoSenderEmail = process.env.BREVO_SENDER_EMAIL;

    if (brevoApiKey && brevoSenderEmail) {
      const brevoResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'accept': 'application/json', 'api-key': brevoApiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          sender: { name: "Soporte AcademiaPro", email: brevoSenderEmail },
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

      if (!brevoResponse.ok) {
        const errorData = await brevoResponse.json();
        console.error(`❌ Brevo rechazó el correo de restablecimiento:`, errorData);
      }
    }

    res.json({ message: 'Contraseña restablecida y enviada por correo' });
  } catch (error) {
    console.error('❌ Error al restablecer contraseña:', error);
    res.status(500).json({ error: error.message || 'Error al restablecer contraseña' });
  }
});

module.exports = router;
