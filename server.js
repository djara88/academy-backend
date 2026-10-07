require('dotenv').config();
const express = require('express');
const cors = require('cors');
const supabase = require('./config/supabase');
const authMiddleware = require('./middleware/auth');
const jerseyReservationGuard = require('./middleware/jerseyReservationGuard');
const { createRateLimiter } = require('./middleware/rateLimit');
const { warmRateLimitStore } = require('./services/redisRateLimitStore');
const { requireFeature } = require('./middleware/planAccess');
const { FEATURES } = require('./services/planCatalog');
const { validatePassword } = require('./services/passwordPolicy');
const { requestFailureRecorder } = require('./services/systemMonitor');
const { startSystemMetricsSampler } = require('./services/systemMetrics');
const { startPresenceSampler } = require('./services/userPresence');
const { startAcademyRegistrationNotifier } = require('./services/academyRegistrationNotifier');
const { startCollectionAutomation } = require('./services/collectionAutomation');
const { startSubscriptionRenewalAutomation } = require('./services/subscriptionContract');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const allowedOrigins = new Set([
  'https://academy-frontend-wheat.vercel.app',
  'https://lestra.app',
  'https://www.lestra.app',
  'https://deportivo.lestra.app',
  'http://localhost:5173',
  ...(process.env.CORS_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean)
]);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https')) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});

app.use(requestFailureRecorder);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Origen no autorizado por CORS'));
  }
}));

const apiLimiter = createRateLimiter({
  namespace: 'api',
  windowMs: 5 * 60 * 1000,
  max: Math.max(100, Number(process.env.API_RATE_LIMIT_MAX || 300)),
  skip: (req) => req.originalUrl?.startsWith('/api/whatsapp/webhook/')
    || req.originalUrl?.startsWith('/api/whatsapp-bridge/webhook/')
    || req.originalUrl?.startsWith('/api/mercadopago/webhook')
    || req.originalUrl?.startsWith('/api/presence/heartbeat'),
});
const sensitiveLimiter = createRateLimiter({
  namespace: 'sensitive',
  windowMs: 15 * 60 * 1000,
  max: Math.max(10, Number(process.env.SENSITIVE_RATE_LIMIT_MAX || 30)),
  message: 'Demasiados intentos en esta operación. Espera unos minutos antes de reintentar.',
  failClosed: true,
});
const paymentLimiter = createRateLimiter({
  namespace: 'payment',
  windowMs: 15 * 60 * 1000,
  max: Math.max(10, Number(process.env.PAYMENT_RATE_LIMIT_MAX || process.env.SENSITIVE_RATE_LIMIT_MAX || 30)),
  message: 'Demasiados intentos de pago. Espera unos minutos antes de reintentar.',
  failClosed: true,
});
const webhookLimiter = createRateLimiter({
  namespace: 'webhook',
  windowMs: 60 * 1000,
  max: Math.max(100, Number(process.env.WEBHOOK_RATE_LIMIT_MAX || 300)),
  keyGenerator: (req) => `${req.ip || req.socket?.remoteAddress || 'unknown'}:${String(req.path || req.originalUrl || '').split('?')[0]}`,
  message: 'Se alcanzó temporalmente el límite de eventos para este webhook.',
  failClosed: true,
});
const registrationLimiter = createRateLimiter({
  namespace: 'registration',
  windowMs: 60 * 60 * 1000,
  max: Math.max(3, Number(process.env.REGISTRATION_RATE_LIMIT_MAX || 10)),
  message: 'Se alcanzó temporalmente el límite de registros desde esta conexión.',
  failClosed: true,
});
const collectionLimiter = createRateLimiter({
  namespace: 'collection',
  windowMs: 10 * 60 * 1000,
  max: Math.max(6, Number(process.env.COLLECTION_RATE_LIMIT_MAX || 15)),
  keyGenerator: (req) => `${req.ip || req.socket?.remoteAddress || 'unknown'}:${String(req.params?.slug || '').toLowerCase()}`,
  message: 'Demasiados intentos de consulta de pagos. Espera unos minutos antes de reintentar.',
  failClosed: true,
});

app.use('/api/whatsapp/webhook', webhookLimiter);
app.use('/api/whatsapp-bridge/webhook', webhookLimiter);
app.use('/api/mercadopago/webhook', webhookLimiter);
app.use('/api', apiLimiter);
app.use('/api/cambiar-password', sensitiveLimiter);
app.use('/api/subscriptions/checkout', paymentLimiter);
app.use('/api/subscriptions/guardian-addon/checkout', paymentLimiter);
app.use('/api/subscriptions/payment-notice', paymentLimiter);
app.use('/api/mercadopago/platform-subscription', paymentLimiter);
app.use('/api/prematriculas/public', sensitiveLimiter);
app.use('/api/academias/registro-publico', registrationLimiter);
app.use('/api/solicitudes-admision/public', registrationLimiter);
app.use('/api/cobranza/public', collectionLimiter);

const bodyLimit = process.env.JSON_BODY_LIMIT || '10mb';
app.use(express.json({ limit: bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: bodyLimit }));

app.use('/api/academias/registro-publico', (req, res, next) => {
  const validation = validatePassword(req.body?.password);
  if (!validation.valid) return res.status(400).json({ error: validation.message, code: 'WEAK_PASSWORD' });
  return next();
});

app.get('/', (_req, res) => res.send('API de Lestra funcionando 🚀'));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/api/cambiar-password', authMiddleware, async (req, res) => {
  try {
    const { newPassword } = req.body;
    const userId = req.user?.id || req.user?.sub || req.user?.userId;
    if (!userId) return res.status(400).json({ error: 'No se pudo identificar el ID del usuario en el token.' });
    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.valid) return res.status(400).json({ error: passwordValidation.message, code: 'WEAK_PASSWORD' });
    const { error: authError } = await supabase.auth.admin.updateUserById(userId, { password: newPassword });
    if (authError) throw authError;
    const { data, error: dbError } = await supabase.from('usuarios').update({ requiere_cambio_password: false }).eq('id', userId).select();
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
const admissionRequestsRoutes = require('./routes/admissionRequests');
const jugadorRoutes = require('./routes/jugadores');
const alumnosRecognitionNotificationsRoutes = require('./routes/alumnosRecognitionNotifications');
const alumnosReportsRoutes = require('./routes/alumnosReports');
const alumnosRoutes = require('./routes/alumnos');
const categoriaRoutes = require('./routes/categorias');
const tutorRoutes = require('./routes/tutores');
const evaluacionRoutes = require('./routes/evaluaciones');
const fichaMedicaRoutes = require('./routes/ficha_medica');
const torneoRoutes = require('./routes/torneos');
const torneoLifecycleRoutes = require('./routes/torneosLifecycle');
const torneoMultiramaRoutes = require('./routes/torneosMultirama');
const competitionStructureRoutes = require('./routes/competitionStructure');
const partidoRoutes = require('./routes/partidos');
const partidoMultiramaRoutes = require('./routes/partidosMultirama');
const rendimientoRoutes = require('./routes/rendimiento');
const rendimientoAnalyticsRoutes = require('./routes/rendimientoAnalytics');
const academiaRoutes = require('./routes/academias');
const academyOnboardingMultiramaRoutes = require('./routes/academyOnboardingMultirama');
const matriculaRoutes = require('./routes/matriculas');
const whatsappRoutes = require('./routes/whatsapp');
const whatsappBridgeRoutes = require('./routes/whatsappBridge');
const whatsappGroupRoutes = require('./routes/whatsappGroups');
const finanzasRoutes = require('./routes/finanzas');
const finanzasMultiramaRoutes = require('./routes/finanzasMultirama');
const collectionAdminRoutes = require('./routes/collectionAdmin');
const mercadoPagoRoutes = require('./routes/mercadoPago');
const paymentReceiptsRoutes = require('./routes/paymentReceipts');
const platformCheckoutRoutes = require('./routes/platformCheckout');
const entrenamientosRoutes = require('./routes/entrenamientos');
const entrenamientosMultiramaRoutes = require('./routes/entrenamientosMultirama');
const attendanceRosterRoutes = require('./routes/attendanceRoster');
const uniformesRoutes = require('./routes/uniformes');
const uniformesMultiramaRoutes = require('./routes/uniformesMultirama');
const jerseyNumberRoutes = require('./routes/jerseyNumbers');
const professorLiveConcurrencyRoutes = require('./routes/professorLiveConcurrency');
const professorOpsRoutes = require('./routes/professorOps');
const professorBoardsRoutes = require('./routes/professorBoards');
const profesoresRoutes = require('./routes/profesores');
const profesoresMultiramaRoutes = require('./routes/profesoresMultirama');
const apoderadosRoutes = require('./routes/apoderados');
const guardianEnrollmentsRoutes = require('./routes/guardianEnrollments');
const dashboardRoutes = require('./routes/dashboard');
const saasAdminRoutes = require('./routes/saasAdmin');
const subscriptionRoutes = require('./routes/subscriptionsPaidGuardians');
const privacyRequestRoutes = require('./routes/privacyRequests');
const chatRoutes = require('./routes/chat');
const systemMetricsRoutes = require('./routes/systemMetrics');
const estructuraRoutes = require('./routes/estructura');
const sportProfileRoutes = require('./routes/sportProfiles');
const publicCatalogRoutes = require('./routes/publicCatalog');
const collectionsPortalRoutes = require('./routes/collectionsPortal');
const presenceRoutes = require('./routes/presence');
const presenceAdminRoutes = require('./routes/presenceAdmin');
const inscripcionesRoutes = require('./routes/inscripciones');

app.use('/api/public', publicCatalogRoutes);
app.use('/api/cobranza', collectionsPortalRoutes);
app.use('/api/cobranza/recibos', paymentReceiptsRoutes);
app.use('/api/mercadopago/platform-subscription', platformCheckoutRoutes);
app.use('/api/mercadopago', mercadoPagoRoutes);
app.use('/api/solicitudes-admision', admissionRequestsRoutes);
app.use('/api/presence', presenceRoutes);
app.use('/api/saas-admin/presence', presenceAdminRoutes);
app.use('/api/jugadores', documentoJugadorRoutes);
app.use('/api/consentimientos', consentimientoRoutes);
app.post('/api/prematriculas', authMiddleware, jerseyReservationGuard);
app.put('/api/prematriculas/:id', authMiddleware, jerseyReservationGuard);
app.use('/api/prematriculas', prematriculaRoutes);
app.use('/api/importaciones', importacionRoutes);

app.post('/api/jugadores/:jugadorId/evaluaciones', authMiddleware, ...requireFeature(FEATURES.EVALUATIONS), (_req, res) => {
  res.status(410).json({ error: 'Esta ruta de evaluación fue reemplazada por el motor multideporte.', code: 'LEGACY_EVALUATION_ROUTE' });
});
app.get('/api/jugadores/categorias/:categoriaId/promedio', authMiddleware, ...requireFeature(FEATURES.EVALUATIONS), evaluacionRoutes.categoryAverageHandler);

app.use('/api', categoriaRoutes);
app.use('/api/alumnos', alumnosRecognitionNotificationsRoutes);
app.use('/api/alumnos', alumnosReportsRoutes);
app.use('/api/alumnos', alumnosRoutes);
app.use('/api/jugadores', jugadorRoutes);
app.use('/api/inscripciones', inscripcionesRoutes);
app.use('/api/tutores', tutorRoutes);
app.use('/api/evaluaciones', authMiddleware, ...requireFeature(FEATURES.EVALUATIONS), evaluacionRoutes);
app.use('/api/sport-profiles', sportProfileRoutes);
app.use('/api/ficha-medica', authMiddleware, ...requireFeature(FEATURES.MEDICAL), fichaMedicaRoutes);
app.use('/api/rendimiento/analitica', authMiddleware, ...requireFeature(FEATURES.ADVANCED_ANALYTICS), rendimientoAnalyticsRoutes);
app.use('/api/rendimiento', authMiddleware, ...requireFeature(FEATURES.MATCHES), rendimientoRoutes);

app.use('/api/torneos', authMiddleware, ...requireFeature(FEATURES.TOURNAMENTS), torneoLifecycleRoutes);
app.use('/api/torneos', authMiddleware, ...requireFeature(FEATURES.TOURNAMENTS), competitionStructureRoutes);
app.use('/api/torneos', authMiddleware, ...requireFeature(FEATURES.TOURNAMENTS), torneoMultiramaRoutes);
app.use('/api/torneos', authMiddleware, ...requireFeature(FEATURES.TOURNAMENTS), torneoRoutes);
app.use('/api/partidos', authMiddleware, ...requireFeature(FEATURES.MATCHES), partidoMultiramaRoutes);
app.use('/api/partidos', authMiddleware, ...requireFeature(FEATURES.MATCHES), rendimientoRoutes);
app.use('/api/partidos', authMiddleware, ...requireFeature(FEATURES.MATCHES), partidoRoutes);
app.use('/api/academias', academyOnboardingMultiramaRoutes);
app.use('/api/academias', academiaRoutes);
app.use('/api/matriculas', matriculaRoutes);
app.use('/api/whatsapp-bridge', whatsappBridgeRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/chat/whatsapp-groups', whatsappGroupRoutes);
app.use('/api/finanzas/cobranza', collectionAdminRoutes);
app.use('/api/finanzas', finanzasMultiramaRoutes);
app.use('/api/finanzas', finanzasRoutes);
app.use('/api/entrenamientos', attendanceRosterRoutes);
app.use('/api/entrenamientos', entrenamientosMultiramaRoutes);
app.use('/api/entrenamientos', entrenamientosRoutes);
app.use('/api/uniformes/dorsales', jerseyNumberRoutes);
app.use('/api/uniformes', uniformesMultiramaRoutes);
app.use('/api/uniformes', uniformesRoutes);
app.use('/api/profesores', professorLiveConcurrencyRoutes);
app.use('/api/profesores', professorOpsRoutes);
app.use('/api/profesores', professorBoardsRoutes);
app.use('/api/profesores', profesoresMultiramaRoutes);
app.use('/api/profesores', profesoresRoutes);
app.use('/api/apoderados/me/pagos', require('./routes/guardianPaymentPortal'));
app.use('/api/apoderados/me/inscripciones-deportivas', guardianEnrollmentsRoutes);
app.use('/api/apoderados', apoderadosRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/saas-admin', saasAdminRoutes);
app.use('/api/saas-admin/metrics', systemMetricsRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/privacy-requests', privacyRequestRoutes);
app.use('/api/estructura', estructuraRoutes);
app.use('/api/chat', chatRoutes);

app.use((error, _req, res, next) => {
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'La solicitud supera el tamaño máximo permitido.' });
  if (error?.message === 'Origen no autorizado por CORS') return res.status(403).json({ error: 'Origen no autorizado.' });
  return next(error);
});

const port = process.env.PORT || 8080;
const server = app.listen(port, '0.0.0.0', () => console.log(`Servidor escuchando en http://0.0.0.0:${port}`));
warmRateLimitStore()
  .then(({ kind }) => console.log(`🛡️ Rate limit store listo: ${kind}`))
  .catch((error) => {
    console.error('❌ Rate limit store no disponible:', error?.message || error);
    if (String(process.env.RATE_LIMIT_REDIS_REQUIRED || '').toLowerCase() === 'true') process.exit(1);
  });
const systemMetricsSampler = startSystemMetricsSampler();
const presenceSampler = startPresenceSampler();
const academyRegistrationNotifier = startAcademyRegistrationNotifier();
const collectionAutomation = startCollectionAutomation();
const subscriptionRenewalAutomation = startSubscriptionRenewalAutomation();

server.requestTimeout = Math.max(15000, Number(process.env.HTTP_REQUEST_TIMEOUT_MS || 30000));
server.headersTimeout = Math.min(server.requestTimeout, Math.max(5000, Number(process.env.HTTP_HEADERS_TIMEOUT_MS || 15000)));
server.keepAliveTimeout = Math.max(1000, Number(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS || 5000));