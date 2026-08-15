require('dotenv').config();
const express = require('express');
const cors = require('cors');
const supabase = require('./config/supabase');
const authMiddleware = require('./middleware/auth');
const { requireFeature } = require('./middleware/planAccess');
const { FEATURES } = require('./services/planCatalog');
const { configurarWebhook } = require('./services/whatsappService');

const app = express();
const allowedOrigins = new Set([
  'https://academy-frontend-wheat.vercel.app',
  'http://localhost:5173',
  ...(process.env.CORS_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean)
]);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Origen no autorizado por CORS'));
  }
}));

// 🔥 LÍMITES AUMENTADOS A 50MB PARA PERMITIR PDFs PESADOS
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.get('/', (req, res) => {
  res.send('API de Syncademia funcionando 🚀');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'syncademia-backend',
    features: { profesores: true },
    commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) || null,
    checked_at: new Date().toISOString(),
  });
});

// ============================
// 🔥 CAMBIAR CLAVE OBLIGATORIA (BLINDADO)
// ============================
app.post('/api/cambiar-password', authMiddleware, async (req, res) => {
  try {
    const { newPassword } = req.body;
    const userId = req.user?.id || req.user?.sub || req.user?.userId;

    if (!userId) {
      return res.status(400).json({ error: 'No se pudo identificar el ID del usuario en el token.' });
    }

    const { error: authError } = await supabase.auth.admin.updateUserById(userId, { password: newPassword });
    if (authError) throw authError;

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
const whatsappRoutes = require('./routes/whatsapp');
const finanzasRoutes = require('./routes/finanzas');
const entrenamientosRoutes = require('./routes/entrenamientos');
const uniformesRoutes = require('./routes/uniformes');
const profesoresRoutes = require('./routes/profesores');
const apoderadosRoutes = require('./routes/apoderados');
const dashboardRoutes = require('./routes/dashboard');
const saasAdminRoutes = require('./routes/saasAdmin');
const subscriptionRoutes = require('./routes/subscriptions');

app.use('/api/jugadores', jugadorRoutes);
app.use('/api/tutores', tutorRoutes);
app.use('/api/evaluaciones', authMiddleware, ...requireFeature(FEATURES.EVALUATIONS), evaluacionRoutes);
app.use('/api/ficha-medica', authMiddleware, ...requireFeature(FEATURES.MEDICAL), fichaMedicaRoutes);
app.use('/api/torneos', authMiddleware, ...requireFeature(FEATURES.TOURNAMENTS), torneoRoutes);
app.use('/api/partidos', partidoRoutes);
app.use('/api/academias', academiaRoutes);
app.use('/api/matriculas', matriculaRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/finanzas', finanzasRoutes);
app.use('/api/entrenamientos', entrenamientosRoutes);
app.use('/api/uniformes', uniformesRoutes);
app.use('/api/profesores', profesoresRoutes);
app.use('/api/apoderados', apoderadosRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/saas-admin', saasAdminRoutes);
app.use('/api/subscriptions', subscriptionRoutes);

const syncActiveAcademyWebhooks = async () => {
  if (!process.env.EVOLUTION_API_URL || !process.env.EVOLUTION_API_KEY || !process.env.WHATSAPP_WEBHOOK_SECRET) {
    console.warn('⚠️ Sincronización automática de webhooks omitida: configuración de Evolution/webhook incompleta.');
    return;
  }

  try {
    const { data: academias, error } = await supabase
      .from('academias')
      .select('id')
      .eq('estado', 'Activa');

    if (error) throw error;

    for (const academia of academias || []) {
      await configurarWebhook(academia.id);
    }

    console.log(`🔐 Webhooks seguros sincronizados para ${(academias || []).length} academia(s) activa(s).`);
  } catch (error) {
    console.error('❌ No fue posible sincronizar los webhooks seguros al iniciar:', error.message);
  }
};

const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor escuchando en http://0.0.0.0:${port}`);
  void syncActiveAcademyWebhooks();
});
