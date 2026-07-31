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
// LOGIN (CON CREACIÓN AUTOMÁTICA DE USUARIO)
// ============================
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  
  // 1. Autenticar con Supabase Auth
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return res.status(401).json({ error: error.message });
  }

  const token = data.session.access_token;
  const userId = data.user.id;

  // 2. Buscar en public.usuarios
  let { data: userData, error: userError } = await supabase
    .from('usuarios')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  // 3. Si no existe, CREARLO AUTOMÁTICAMENTE
  if (userError || !userData) {
    console.log(`⚠️ Usuario ${email} no encontrado en public.usuarios. Creando...`);
    
    // Determinar si es el primer usuario (superadmin) o uno nuevo
    const { count, error: countError } = await supabase
      .from('usuarios')
      .select('*', { count: 'exact', head: true });
    
    const isFirstUser = count === 0;
    
    const newUser = {
      id: userId,
      academia_id: '11111111-1111-1111-1111-111111111111',
      nombre_completo: data.user.user_metadata?.full_name || email.split('@')[0],
      rol: isFirstUser ? 'superadmin' : 'profesor'
    };

    const { data: inserted, error: insertError } = await supabase
      .from('usuarios')
      .insert([newUser])
      .select()
      .single();

    if (insertError) {
      console.error('❌ Error al crear usuario:', insertError);
      return res.status(500).json({ error: 'Error al crear usuario en el sistema' });
    }

    userData = inserted;
    console.log(`✅ Usuario ${email} creado con rol: ${userData.rol}`);
  }

  // 4. Responder con token y datos del usuario
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
