require('dotenv').config();
const express = require('express');
const cors = require('cors');
const supabase = require('./config/supabase');

const app = express();

// Middlewares
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Ruta de prueba
app.get('/', (req, res) => {
  res.send('API de Academia Multi-tenant funcionando 🚀');
});

// ============================
// LOGIN
// ============================
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return res.status(401).json({ error: error.message });
  }

  const token = data.session.access_token;
  const { data: userData, error: userError } = await supabase
    .from('usuarios')
    .select('*')
    .eq('id', data.user.id)
    .single();

  if (userError || !userData) {
    return res.status(403).json({ error: 'Usuario no registrado en el sistema' });
  }

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

// ============================
// RUTAS
// ============================
const authMiddleware = require('./middleware/auth');
const jugadorRoutes = require('./routes/jugadores');
const tutorRoutes = require('./routes/tutores');
const evaluacionRoutes = require('./routes/evaluaciones');
const fichaMedicaRoutes = require('./routes/ficha_medica');
const torneoRoutes = require('./routes/torneos');
const partidoRoutes = require('./routes/partidos');

app.use('/api/jugadores', jugadorRoutes);
app.use('/api/tutores', tutorRoutes);
app.use('/api/evaluaciones', evaluacionRoutes);
app.use('/api/ficha-medica', fichaMedicaRoutes);
app.use('/api/torneos', torneoRoutes);
app.use('/api/partidos', partidoRoutes);

// ============================
// PUERTO
// ============================
const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor escuchando en http://0.0.0.0:${port}`);
});
