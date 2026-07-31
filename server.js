require('dotenv').config();
const express = require('express');
const cors = require('cors');
const supabase = require('./config/supabase');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.send('API de Academia Multi-tenant funcionando 🚀');
});

// Login con creación automática de usuario en public.usuarios si no existe
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
    .maybeSingle();

  if (userError || !userData) {
    const { data: newUser, error: insertError } = await supabase
      .from('usuarios')
      .insert([{
        id: data.user.id,
        academia_id: '11111111-1111-1111-1111-111111111111',
        nombre_completo: data.user.email?.split('@')[0] || 'Usuario',
        rol: 'superadmin'
      }])
      .select()
      .single();

    if (insertError || !newUser) {
      return res.status(403).json({ error: 'Error al crear usuario' });
    }

    return res.json({
      token,
      user: {
        id: newUser.id,
        email: data.user.email,
        nombre_completo: newUser.nombre_completo,
        rol: newUser.rol,
        academia_id: newUser.academia_id,
      }
    });
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

// Rutas
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

const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor escuchando en http://0.0.0.0:${port}`);
});
