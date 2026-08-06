require('dotenv').config();
const express = require('express');
const cors = require('cors');
const supabase = require('./config/supabase');
const authMiddleware = require('./middleware/auth');

const app = express();
app.use(cors());

// 🔥 LÍMITES AUMENTADOS A 50MB PARA PERMITIR PDFs PESADOS
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.get('/', (req, res) => {
  res.send('API de Academia Multi-tenant funcionando 🚀');
});

// ============================
// LOGIN CON CREACIÓN AUTOMÁTICA
// ============================
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  
  if (error) {
    return res.status(401).json({ error: error.message });
  }

  const token = data.session.access_token;
  const userId = data.user.id;

  let { data: userData, error: userError } = await supabase
    .from('usuarios')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (userError || !userData) {
    const { count } = await supabase.from('usuarios').select('*', { count: 'exact', head: true });
    const isFirstUser = count === 0;

    const { data: inserted, error: insertError } = await supabase
      .from('usuarios')
      .insert([{
        id: userId,
        academia_id: '11111111-1111-1111-1111-111111111111',
        nombre_completo: data.user.user_metadata?.full_name || email.split('@')[0],
        rol: isFirstUser ? 'superadmin' : 'profesor',
        requiere_cambio_password: false
      }])
      .select()
      .single();

    if (insertError) return res.status(500).json({ error: 'Error al crear usuario' });
    userData = inserted;
  }

  res.json({
    token,
    user: {
      id: userData.id,
      email: data.user.email,
      nombre_completo: userData.nombre_completo,
      rol: userData.rol,
      academia_id: userData.academia_id,
      requiere_cambio_password: userData.requiere_cambio_password // Frontend lee esto para redirigir
    }
  });
});

// ============================
// 🔥 CAMBIAR CLAVE OBLIGATORIA (BLINDADO)
// ============================
app.post('/api/cambiar-password', authMiddleware, async (req, res) => {
  try {
    const { newPassword } = req.body;
    
    // Extraemos el ID cubriendo todos los formatos posibles de JWT
    const userId = req.user?.id || req.user?.sub || req.user?.userId;

    if (!userId) {
      return res.status(400).json({ error: 'No se pudo identificar el ID del usuario en el token.' });
    }

    // 1. Cambiar contraseña en Auth
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, { password: newPassword });
    if (authError) throw authError;

    // 2. Quitar la marca en la base de datos (Fuerza la confirmación con .select)
    const { data, error: dbError } = await supabase
      .from('usuarios')
      .update({ requiere_cambio_password: false })
      .eq('id', userId)
      .select();

    if (dbError) throw dbError;

    if (!data || data.length === 0) {
      console.warn(`⚠️ OJO: Se cambió la clave en Auth, pero no se encontró la fila en la tabla 'usuarios' para el ID: ${userId}`);
    } else {
      console.log(`✅ Marca de cambio de contraseña removida con éxito para el usuario: ${userId}`);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error al actualizar contraseña:', error);
    res.status(500).json({ error: 'Error interno al actualizar la contraseña' });
  }
});

// ============================
// RUTAS DE LA APLICACIÓN
// ============================
const jugadorRoutes = require('./routes/jugadores');
const tutorRoutes = require('./routes/tutores');
const evaluacionRoutes = require('./routes/evaluaciones');
const fichaMedicaRoutes = require('./routes/ficha_medica');
const torneoRoutes = require('./routes/torneos');
const partidoRoutes = require('./routes/partidos');
const academiaRoutes = require('./routes/academias');
const matriculaRoutes = require('./routes/matriculas');

app.use('/api/jugadores', jugadorRoutes);
app.use('/api/tutores', tutorRoutes);
app.use('/api/evaluaciones', evaluacionRoutes);
app.use('/api/ficha-medica', fichaMedicaRoutes);
app.use('/api/torneos', torneoRoutes);
app.use('/api/partidos', partidoRoutes);
app.use('/api/academias', academiaRoutes);
app.use('/api/matriculas', matriculaRoutes);

const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor escuchando en http://0.0.0.0:${port}`);
});
