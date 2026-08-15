require('dotenv').config();
const express = require('express');
const cors = require('cors');
const supabase = require('./config/supabase');
const authMiddleware = require('./middleware/auth');
const { createRateLimiter } = require('./middleware/rateLimit');
const { requireFeature } = require('./middleware/planAccess');
const { FEATURES } = require('./services/planCatalog');
const { validatePassword } = require('./services/passwordPolicy');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const allowedOrigins = new Set([
  'https://academy-frontend-wheat.vercel.app',
  'http://localhost:5173',
  ...(process.env.CORS_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean)
]);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  next();
});

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Origen no autorizado por CORS'));
  }
}));

const apiLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: Math.max(100, Number(process.env.API_RATE_LIMIT_MAX || 300)),
  skip: (req) => req.originalUrl?.startsWith('/api/whatsapp/webhook/'),
});
const sensitiveLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Math.max(10, Number(process.env.SENSITIVE_RATE_LIMIT_MAX || 30)),
  message: 'Demasiados intentos en esta operación. Espera unos minutos antes de reintentar.',
});
const registrationLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: Math.max(3, Number(process.env.REGISTRATION_RATE_LIMIT_MAX || 10)),
  message: 'Se alcanzó temporalmente el límite de registros desde esta conexión.',
});

app.use('/api', apiLimiter);
app.use('/api/cambiar-password', sensitiveLimiter);
app.use('/api/subscriptions/checkout', sensitiveLimiter);
app.use('/api/subscriptions/payment-notice', sensitiveLimiter);
app.use('/api/prematriculas/public', sensitiveLimiter);
app.use('/api/academias/registro-publico', registrationLimiter);

const bodyLimit = process.env.JSON_BODY_LIMIT || '10mb';
app.use(express.json({ limit: bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: bodyLimit }));

app.use('/api/academias/registro-publico', (req, res, next) => {
  const validation = validatePassword(req.body?.password);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.message, code: 'WEAK_PASSWORD' });
  }
  return next();
});

app.get('/', (_req, res) => {
  res.send('API de Syncademia funcionando 🚀');
});

app.get('/health', (_req, res) => {
  const memory = process.memoryUsage();
  res.json({
    status: 'ok',
    service: 'syncademia-backend',
    features: { profesores: true },
    commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) || null,
    uptime_seconds: Math.round(process.uptime()),
    memory_rss_mb: Math.round(memory.rss / 1024 / 1024),
    checked_at: new Date().toISOString(),
  });
});

app.post('/api/cambiar-password', authMiddleware, async (req, res) => {
  try {
    const { newPassword } = req.body;
    const userId = req.user?.id || req.user?.sub || req.user?.userId;
    if (!userId) return res.status(400).json({ error: 'No se pudo identificar el ID del usuario en el token.' });

    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.message, code: 'WEAK_PASSWORD' });
    }

    const { error: authError } = await supabase.auth.admin.updateUserById(userId, { password: newPassword });
    if (authError) throw authError;

    const { data, error: dbError } = await supabase.from('usuarios')
      .update({ requiere_cambio_password: false }).eq('id', userId).select();
    if (dbError) throw dbError;
    if (!data || data.length === 0) console.warn('Se cambió la clave en Auth, pero no se encontró la fila correspondiente en usuarios.');
    res.json({ success: true });
  } catch (error) {
    console.error('Error al actualizar contraseña:', error?.message || 'Error desconocido');
    res.status(500).json({ error: 'Error interno al actualizar la contraseña' });
  }
});

const documentoJugadorRoutes = require('./routes/documentos');
const consentimientoRoutes = require('./routes/consentimientos');
const prematriculaRoutes = require('./routes/prematriculas');
const importacionRoutes = require('./routes/importaciones');
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

app.use('/api/jugadores', documentoJugadorRoutes);
app.use('/api/consentimientos', consentimientoRoutes);
app.use('/api/prematriculas', prematriculaRoutes);
app.use('/api/importaciones', importacionRoutes);
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

app.use((error, _req, res, next) => {
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'La solicitud supera el tamaño máximo permitido.' });
  if (error?.message === 'Origen no autorizado por CORS') return res.status(403).json({ error: 'Origen no autorizado.' });
  return next(error);
});

const port = process.env.PORT || 8080;
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor escuchando en http://0.0.0.0:${port}`);
});

server.requestTimeout = Math.max(15000, Number(process.env.HTTP_REQUEST_TIMEOUT_MS || 30000));
server.headersTimeout = Math.min(server.requestTimeout, Math.max(5000, Number(process.env.HTTP_HEADERS_TIMEOUT_MS || 15000)));
server.keepAliveTimeout = Math.max(1000, Number(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS || 5000));

let shuttingDown = false;
const gracefulShutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} recibido. Cerrando conexiones de forma ordenada...`);
  const forceTimer = setTimeout(() => {
    console.error('Cierre ordenado excedió 25 segundos; cerrando conexiones restantes.');
    server.closeAllConnections?.();
    process.exit(1);
  }, 25000);
  forceTimer.unref?.();
  server.close(() => {
    clearTimeout(forceTimer);
    console.log('Servidor HTTP cerrado correctamente.');
    process.exit(0);
  });
};

process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.once('SIGINT', () => gracefulShutdown('SIGINT'));
