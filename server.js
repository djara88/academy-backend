require('dotenv').config();
const express = require('express');
const cors = require('cors');
const supabase = require('./config/supabase'); // ← ESTA LÍNEA ES CLAVE
const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('API de Academia Multi-tenant funcionando 🚀');
});

// TEMPORAL: endpoint de login para pruebas
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  // 1. Autenticar con Supabase
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
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

// Importar rutas
const jugadorRoutes = require('./routes/jugadores');
app.use('/api/jugadores', jugadorRoutes);

app.listen(port, '127.0.0.1', () => {
  console.log(`Servidor escuchando en http://localhost:${port}`);
});