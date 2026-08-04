const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const multer = require('multer');

// Configuración de Multer para guardar archivos temporalmente en memoria
const upload = multer({ storage: multer.memoryStorage() });

// ====================================================================
// 🚀 NUEVA RUTA: REGISTRO PÚBLICO AUTOMÁTICO (SELF-SERVICE)
// ====================================================================
router.post('/registro-publico', async (req, res) => {
  const { nombre_academia, nombre_director, email, password } = req.body;
  let createdAuthUser = null;

  try {
    // 1. Crear el usuario en Supabase Auth con la contraseña que el cliente eligió
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true
    });

    if (authError) {
      if (authError.code === 'user_already_exists' || authError.status === 422) {
        return res.status(400).json({ error: 'Este correo ya está registrado en el sistema.' });
      }
      throw authError;
    }

    createdAuthUser = authData.user;

    // 2. Crear la Academia en la base de datos (Plan Básico por defecto)
    const { data: nuevaAcademia, error: dbError } = await supabase
      .from('academias')
      .insert([{ 
        nombre: nombre_academia, 
        nombre_director: nombre_director, 
        director_email: email, 
        plan: 'Prueba 15 Días', // Plan inicial automático
        estado: 'Activa', 
        jugadores_count: 0
      }])
      .select()
      .single();

    if (dbError) throw dbError;

    // 3. Vincular al director con su academia Y marcar que NO requiere cambio de clave
    const { error: userTableError } = await supabase.from('usuarios').insert([{
      id: createdAuthUser.id,
      academia_id: nuevaAcademia.id,
      nombre_completo: nombre_director,
      rol: 'director',
      requiere_cambio_password: false // 🔥 Entra directo porque él creó su clave
    }]);

    if (userTableError) throw userTableError;

    // 4. Enviar correo de bienvenida por Brevo
    const brevoApiKey = process.env.BREVO_API_KEY;
    const brevoSenderEmail = process.env.BREVO_SENDER_EMAIL;

    if (brevoApiKey && brevoSenderEmail) {
      try {
        await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'accept': 'application/json',
            'api-key': brevoApiKey,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            sender: { name: "AcademiaPro", email: brevoSenderEmail },
            to: [{ email: email }],
            subject: "¡Bienvenido a AcademiaPro! 🚀",
            htmlContent: `
              <div style="font-family: sans-serif; color: #333;">
                <h2>¡Hola ${nombre_director}! Bienvenido a AcademiaPro</h2>
                <p>Tu academia <strong>${nombre_academia}</strong> ha sido creada con éxito.</p>
                <p>Tienes 15 días de prueba gratis para disfrutar de todas las funcionalidades.</p>
                <p>Ya puedes iniciar sesión en la plataforma utilizando tu correo y la contraseña que creaste durante el registro.</p>
                <br/>
                <p>¡Mucho éxito en tu gestión!</p>
                <p>El equipo de AcademiaPro</p>
              </div>
            `
          })
        });
      } catch (fetchError) {
        console.error(`❌ Error al enviar correo de bienvenida:`, fetchError);
      }
    }

    res.status(201).json({ success: true, academia: nuevaAcademia });

  } catch (error) {
    console.error('❌ Error en registro público:', error);
    if (createdAuthUser) {
      await supabase.auth.admin.deleteUser(createdAuthUser.id);
    }
    res.status(500).json({ error: error.message || 'Error interno del servidor al crear tu cuenta' });
  }
});


// ====================================================================
// 🚀 NUEVA RUTA: COMPLETAR PERFIL CON GOOGLE (CON LOGO Y 15 DÍAS)
// ====================================================================
router.post('/completar-google', upload.single('logo'), async (req, res) => {
  try {
    const { auth_id, email, nombre_director, nombre_academia, direccion } = req.body;

    let logoUrl = null;

    // 1. Subir el logo a Supabase Storage (Bucket 'logos-escuelas')
    if (req.file) {
      const fileName = `${Date.now()}_${req.file.originalname.replace(/\s+/g, '_')}`;
      const { error: uploadError } = await supabase.storage
        .from('logos-escuelas')
        .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });

      if (uploadError) {
        console.error('⚠️ Error al subir logo:', uploadError);
      } else {
        const { data: publicUrlData } = supabase.storage
          .from('logos-escuelas')
          .getPublicUrl(fileName);
        logoUrl = publicUrlData.publicUrl;
      }
    }

    // 2. Crear la Academia en la BD
    const { data: nuevaAcademia, error: dbError } = await supabase
      .from('academias')
      .insert([{ 
        nombre: nombre_academia, 
        direccion: direccion,
        logo: logoUrl,
        nombre_director: nombre_director, 
        director_email: email, 
        plan: 'Prueba 15 Días', 
        estado: 'Activa', 
        jugadores_count: 0
      }])
      .select()
      .single();

    if (dbError) throw dbError;

    // 3. Vincular al usuario de Google en la tabla 'usuarios'
    const { error: userTableError } = await supabase.from('usuarios').insert([{
      id: auth_id,
      academia_id: nuevaAcademia.id,
      nombre_completo: nombre_director,
      rol: 'director',
      requiere_cambio_password: false // Entra directo con Google
    }]);

    if (userTableError) throw userTableError;

    // 4. Enviar correo de bienvenida por Brevo
    const brevoApiKey = process.env.BREVO_API_KEY;
    const brevoSenderEmail = process.env.BREVO_SENDER_EMAIL;

    if (brevoApiKey && brevoSenderEmail) {
      try {
        await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'accept': 'application/json',
            'api-key': brevoApiKey,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            sender: { name: "AcademiaPro", email: brevoSenderEmail },
            to: [{ email: email }],
            subject: "¡Bienvenido a AcademiaPro con Google! 🚀",
            htmlContent: `
              <div style="font-family: sans-serif; color: #333;">
                <h2>¡Hola ${nombre_director}! Bienvenido a AcademiaPro</h2>
                <p>Tu academia <strong>${nombre_academia}</strong> ha sido creada exitosamente mediante tu cuenta de Google.</p>
                <p>Tienes 15 días de prueba gratis activados desde hoy.</p>
                <br/>
                <p>¡Mucho éxito en tu gestión!</p>
                <p>El equipo de AcademiaPro</p>
              </div>
            `
          })
        });
      } catch (fetchError) {
        console.error(`❌ Error al enviar correo de bienvenida Google:`, fetchError);
      }
    }

    res.status(200).json({ success: true, academia: nuevaAcademia });

  } catch (error) {
    console.error('❌ Error en /completar-google:', error);
    res.status(500).json({ error: error.message || 'Error al completar el perfil' });
  }
});


// ====================================================================
// RUTAS DE ADMINISTRACIÓN (SUPERADMIN)
// ====================================================================

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

// 2. CREAR NUEVA ACADEMIA MANUALMENTE (USADO POR EL SUPERADMIN)
router.post('/', upload.single('logo'), async (req, res) => {
  const { 
    nombre, direccion, telefono, correo_academia, 
    nombre_director, director_email, plan 
  } = req.body;

  let createdAuthUser = null;

  try {
    const tempPassword = Math.random().toString(36).substring(2, 10) + "A1!"; 

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: director_email,
      password: tempPassword,
      email_confirm: true
    });

    if (authError) {
      if (authError.code === 'user_already_exists' || authError.status === 422) {
        return res.status(400).json({ 
          error: `El correo "${director_email}" ya está registrado en Auth.` 
        });
      }
      throw authError;
    }

    createdAuthUser = authData.user;

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

    const { data: nuevaAcademia, error: dbError } = await supabase
      .from('academias')
      .insert([{ 
        nombre, logo: logoUrl, direccion, telefono, correo_academia,
        nombre_director, director_email, plan, estado: 'Activa', jugadores_count: 0
      }])
      .select()
      .single();

    if (dbError) throw dbError;

    const { error: userTableError } = await supabase.from('usuarios').insert([{
      id: createdAuthUser.id,
      academia_id: nuevaAcademia.id,
      nombre_completo: nombre_director,
      rol: 'director',
      requiere_cambio_password: true // 🔥 MANUAL REQUIERE CAMBIO DE CLAVE
    }]);

    if (userTableError) console.error("⚠️ Error vinculando usuario:", userTableError);

    const brevoApiKey = process.env.BREVO_API_KEY;
    const brevoSenderEmail = process.env.BREVO_SENDER_EMAIL;

    if (brevoApiKey && brevoSenderEmail) {
      try {
        await fetch('https://api.brevo.com/v3/smtp/email', {
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
                <p>Te recomendamos iniciar sesión y cambiar esta contraseña lo antes posible.</p>
              </div>
            `
          })
        });
      } catch (fetchError) {
        console.error(`❌ Error con Brevo:`, fetchError);
      }
    }

    res.status(201).json(nuevaAcademia);
  } catch (error) {
    if (createdAuthUser) await supabase.auth.admin.deleteUser(createdAuthUser.id);
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
      .single();
    
    if (userData && userData.id) {
      const { error: updateError } = await supabase.auth.admin.updateUserById(userData.id, { password: newPassword });
      if (updateError) throw updateError;

      // 🔥 VOLVEMOS A EXIGIR CAMBIO DE CLAVE CUANDO EL ADMIN LA RESETEA
      await supabase.from('usuarios').update({ requiere_cambio_password: true }).eq('id', userData.id);

    } else {
      throw new Error('No se encontró el usuario asociado a esta academia.');
    }

    const brevoApiKey = process.env.BREVO_API_KEY;
    const brevoSenderEmail = process.env.BREVO_SENDER_EMAIL;

    if (brevoApiKey && brevoSenderEmail) {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'accept': 'application/json', 'api-key': brevoApiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          sender: { name: "Soporte AcademiaPro", email: brevoSenderEmail },
          to: [{ email: academia.director_email }],
          subject: "Restablecimiento de Contraseña - AcademiaPro",
          htmlContent: `
            <h2>Hola ${academia.nombre_director},</h2>
            <p>Tu contraseña ha sido restablecida por el administrador.</p>
            <p><strong>Tu nueva contraseña temporal es:</strong> ${newPassword}</p>
            <p>Por favor, inicia sesión y cámbiala lo antes posible.</p>
          `
        })
      });
    }

    res.json({ message: 'Contraseña restablecida y enviada por correo' });
  } catch (error) {
    console.error('❌ Error al restablecer contraseña:', error);
    res.status(500).json({ error: error.message || 'Error al restablecer contraseña' });
  }
});

module.exports = router;
