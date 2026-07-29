require('dotenv').config();
const express = require('express');
const cors = require('cors');
const supabase = require('./config/supabase'); // Asegúrate de que este archivo exista
const app = express();
const port = process.env.PORT || 8080;

// Middlewares
app.use(cors());
app.use(express.json());

// Ruta de prueba
app.get('/', (req, res) => {
  res.send('API de Academia Multi-tenant funcionando 🚀');
});

// ============================================================
// ENDPOINT DE LOGIN (para el frontend)
// ============================================================
app.post('/api/login', async (req, res) => {
  console.log('📩 Recibida petición de login');
  console.log('📦 Body:', req.body);

  const { email, password } = req.body;

  // 1. Autenticar con Supabase
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.error('❌ Error de autenticación:', error);
    return res.status(401).json({ error: error.message });
  }

  const token = data.session.access_token;

  // 2. Obtener el usuario de nuestra tabla "usuarios"
  const { data: userData, error: userError } = await supabase
    .from('usuarios')
    .select('*')
    .eq('id', data.user.id)
    .single();

  if (userError || !userData) {
    console.error('❌ Usuario no encontrado en tabla usuarios:', userError);
    return res.status(403).json({ error: 'Usuario no registrado en el sistema' });
  }

  // 3. Devolver token y datos del usuario
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

// ============================================================
// RUTAS DE JUGADORES
// ============================================================
const jugadorRoutes = require('./routes/jugadores');
app.use('/api/jugadores', jugadorRoutes);

// ============================================================
// INICIAR SERVIDOR (escuchando en todas las interfaces)
// ============================================================
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor escuchando en http://0.0.0.0:${port}`);
});
