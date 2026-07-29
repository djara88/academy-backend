require('dotenv').config();
const express = require('express');
const cors = require('cors');
const supabase = require('./config/supabase');
const app = express();

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json());

// --- RUTA DE PRUEBA ---
app.get('/', (req, res) => {
  res.send('API de Academia Multi-tenant funcionando 🚀');
});

// --- ENDPOINT DE LOGIN ---
app.post('/api/login', async (req, res) => {
  console.log('📩 Recibida petición de login');
  const { email, password } = req.body;

  // Autenticar con Supabase
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.error('❌ Error de autenticación:', error);
    return res.status(401).json({ error: error.message });
  }

  const token = data.session.access_token;

  // Obtener el usuario de la tabla "usuarios"
  const { data: userData, error: userError } = await supabase
    .from('usuarios')
    .select('*')
    .eq('id', data.user.id)
    .single();

  if (userError || !userData) {
    console.error('❌ Usuario no encontrado:', userError);
    return res.status(403).json({ error: 'Usuario no registrado en el sistema' });
  }

  // Devolver token y datos del usuario
  res.json({
    token,
    user: {
      id: userData.id,
      email: data.user.email,
      nombre_completo: userData.nombre_completo,
      rol: userData.rol,
      academia_id: userData.academia_id,
    }
  });
});

// --- RUTAS DE JUGADORES ---
const jugadorRoutes = require('./routes/jugadores');
app.use('/api/jugadores', jugadorRoutes);

// --- ¡¡¡ PUERTO Y BINDING CORREGIDOS !!! ---
// Usa el puerto que Render asigna (process.env.PORT) o 8080 como fallback.
// ¡IMPORTANTE! Vincular a '0.0.0.0' para que Render pueda enrutar el tráfico.
const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor escuchando en http://0.0.0.0:${port}`);
});
