const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

// ====================================================================
// 🚀 NUEVA RUTA: REGISTRO PÚBLICO AUTOMÁTICO (SELF-SERVICE)
// ====================================================================
router.post('/registro-publico', async (req, res) => {
  const { nombre_academia, nombre_director, email, password } = req.body;
  let createdAuthUser = null;

  try {
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

    const { data: nuevaAcademia, error: dbError } = await supabase
      .from('academias')
      .insert([{ 
        nombre: nombre_academia, 
        nombre_director: nombre_director, 
        director_email: email, 
        plan: 'Prueba 15 Días', 
        estado: 'Activa', 
        jugadores_count: 0
      }])
      .select()
      .single();

    if (dbError) throw dbError;

    const { error: userTableError } = await supabase.from('usuarios').insert([{
      id: createdAuthUser.id,
      academia_id: nuevaAcademia.id,
      nombre_completo: nombre_director,
      rol: 'director',
      requiere_cambio_password: false
    }]);

    if (userTableError) throw userTableError;

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
                <p>Ya puedes iniciar sesión utilizando tu correo y la contraseña que creaste.</p>
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
    if (createdAuthUser) await supabase.auth.admin.deleteUser(createdAuthUser.id);
    res.status(500).json({ error: error.message || 'Error interno del servidor al crear tu cuenta' });
  }
});

// ====================================================================
// 🚀 NUEVA RUTA: COMPLETAR PERFIL CON GOOGLE
// ====================================================================
router.post('/completar-google', upload.single('logo'), async (req, res) => {
  try {
    const { auth_id, email, nombre_director, nombre_academia, direccion } = req.body;
    let logoUrl = null;

    if (req.file) {
      const fileName = `${Date.now()}_${req.file.originalname.replace(/\s+/g, '_')}`;
      const { error: uploadError } = await supabase.storage
        .from('logos-escuelas')
        .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });

      if (!uploadError) {
        const { data: publicUrlData } = supabase.storage.from('logos-escuelas').getPublicUrl(fileName);
        logoUrl = publicUrlData.publicUrl;
      }
    }

    const { data: nuevaAcademia, error: dbError } = await supabase
      .from('academias')
      .insert([{ 
        nombre: nombre_academia, direccion, logo: logoUrl,
        nombre_director, director_email: email, plan: 'Prueba 15 Días', 
        estado: 'Activa', jugadores_count: 0
      }])
      .select()
      .single();

    if (dbError) throw dbError;

    const { error: userTableError } = await supabase.from('usuarios').insert([{
      id: auth_id, academia_id: nuevaAcademia.id,
      nombre_completo: nombre_director, rol: 'director', requiere_cambio_password: false 
    }]);

    if (userTableError) throw userTableError;

    res.status(200).json({ success: true, academia: nuevaAcademia });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Error al completar el perfil' });
  }
});

// ====================================================================
// RUTAS DE ADMINISTRACIÓN
// ====================================================================

router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('academias').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Error de Supabase' });
  res.json(data || []);
});

router.post('/', upload.single('logo'), async (req, res) => {
  const { nombre, direccion, telefono, correo_academia, nombre_director, director_email, plan } = req.body;
  let createdAuthUser = null;

  try {
    const tempPassword = Math.random().toString(36).substring(2, 10) + "A1!"; 

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: director_email, password: tempPassword, email_confirm: true
    });

    if (authError) throw authError;
    createdAuthUser = authData.user;

    let logoUrl = null;
    if (req.file) {
      const fileName = `${Date.now()}_${req.file.originalname.replace(/\s+/g, '_')}`;
      await supabase.storage.from('logos-escuelas').upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
      const { data: publicUrlData } = supabase.storage.from('logos-escuelas').getPublicUrl(fileName);
      logoUrl = publicUrlData.publicUrl;
    }

    const { data: nuevaAcademia, error: dbError } = await supabase
      .from('academias')
      .insert([{ nombre, logo: logoUrl, direccion, telefono, correo_academia, nombre_director, director_email, plan, estado: 'Activa', jugadores_count: 0 }])
      .select().single();

    if (dbError) throw dbError;

    await supabase.from('usuarios').insert([{
      id: createdAuthUser.id, academia_id: nuevaAcademia.id, nombre_completo: nombre_director,
      rol: 'director', requiere_cambio_password: true
    }]);

    res.status(201).json(nuevaAcademia);
  } catch (error) {
    if (createdAuthUser) await supabase.auth.admin.deleteUser(createdAuthUser.id);
    res.status(500).json({ error: error.message || 'Error interno del servidor' });
  }
});

router.put('/:id', upload.single('logo'), async (req, res) => {
  const { id } = req.params;
  const { nombre, direccion, telefono, correo_academia, nombre_director, director_email, plan, estado } = req.body;

  try {
    let updateData = { nombre, direccion, telefono, correo_academia, nombre_director, director_email, plan, estado };
    if (req.file) {
      const fileName = `${Date.now()}_${req.file.originalname.replace(/\s+/g, '_')}`;
      await supabase.storage.from('logos-escuelas').upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
      updateData.logo = supabase.storage.from('logos-escuelas').getPublicUrl(fileName).data.publicUrl;
    }
    const { data, error } = await supabase.from('academias').update(updateData).eq('id', id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabase.from('academias').delete().eq('id', id);
    if (error) throw error;
    res.json({ message: 'Academia eliminada exitosamente' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/reset-password', async (req, res) => {
  const { id } = req.params;
  try {
    const { data: academia, error: acaError } = await supabase.from('academias').select('director_email, nombre_director').eq('id', id).single();
    if (acaError) throw new Error('Academia no encontrada');

    const newPassword = Math.random().toString(36).substring(2, 10) + "X9#"; 
    const { data: userData } = await supabase.from('usuarios').select('id').eq('academia_id', id).single();
    
    if (userData && userData.id) {
      await supabase.auth.admin.updateUserById(userData.id, { password: newPassword });
      await supabase.from('usuarios').update({ requiere_cambio_password: true }).eq('id', userData.id);
    }
    res.json({ message: 'Contraseña restablecida' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ====================================================================
// RUTAS DE TÉRMINOS Y CONDICIONES
// ====================================================================

// Obtener datos y términos de una academia específica
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase.from('academias').select('*').eq('id', id).single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener datos de la academia' });
  }
});

// Actualizar los términos de una academia
router.put('/:id/terminos', async (req, res) => {
  const { id } = req.params;
  const { terminos_condiciones } = req.body;
  
  try {
    const { data, error } = await supabase
      .from('academias')
      .update({ terminos_condiciones })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar términos' });
  }
});

module.exports = router;
