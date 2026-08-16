const supabase = require('../config/supabase');
const { fetchWithTimeout } = require('./httpClient');

const MB = 1024 * 1024;
const memoryLimitMb = Math.max(128, Number(process.env.SYSTEM_MEMORY_LIMIT_MB || 512));
const frontendUrl = String(process.env.FRONTEND_URL || 'https://academy-frontend-wheat.vercel.app').replace(/\/$/, '');
const evolutionUrl = String(process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');

const statusFrom = (ok, warning = false) => ok ? (warning ? 'warning' : 'ok') : 'critical';
const safeError = (error) => String(error?.message || 'Error de conexión').slice(0, 180);

const timed = async (fn) => {
  const started = Date.now();
  try {
    const value = await fn();
    return { ok: true, latency_ms: Date.now() - started, value };
  } catch (error) {
    return { ok: false, latency_ms: Date.now() - started, error: safeError(error) };
  }
};

const checkDatabase = () => timed(async () => {
  const { error, count } = await supabase.from('academias').select('id', { count: 'exact', head: true });
  if (error) throw error;
  return { academias: Number(count || 0) };
});

const checkAuth = () => timed(async () => {
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (error) throw error;
  return { reachable: Boolean(data) };
});

const checkStorage = () => timed(async () => {
  const buckets = ['matriculas-pdf', 'fotos_alumnos', 'logos-escuelas'];
  const results = await Promise.all(buckets.map(async (bucket) => {
    const { data, error } = await supabase.storage.getBucket(bucket);
    if (error) return { bucket, ok: false, error: safeError(error) };
    return { bucket, ok: true, public: Boolean(data?.public), file_size_limit: data?.file_size_limit || null };
  }));
  return results;
});

const checkFrontend = () => timed(async () => {
  const response = await fetchWithTimeout(frontendUrl, { method: 'GET', redirect: 'follow' }, 5000);
  if (!response.ok) throw new Error(`Frontend respondió HTTP ${response.status}`);
  return { http_status: response.status };
});

const checkBrevo = () => timed(async () => {
  if (!process.env.BREVO_API_KEY) throw new Error('BREVO_API_KEY no configurada');
  const response = await fetchWithTimeout('https://api.brevo.com/v3/account', {
    headers: { accept: 'application/json', 'api-key': process.env.BREVO_API_KEY },
  }, 5000);
  if (!response.ok) throw new Error(`Brevo respondió HTTP ${response.status}`);
  return { http_status: response.status };
});

const checkEvolution = () => timed(async () => {
  if (!evolutionUrl || !process.env.EVOLUTION_API_KEY) throw new Error('Evolution API no configurada');
  const response = await fetchWithTimeout(`${evolutionUrl}/instance/fetchInstances`, {
    headers: { apikey: process.env.EVOLUTION_API_KEY },
  }, 5000);
  if (!response.ok) throw new Error(`Evolution respondió HTTP ${response.status}`);
  const data = await response.json().catch(() => []);
  return { http_status: response.status, instances: Array.isArray(data) ? data.length : null };
});

const recordSystemEvent = async ({ severity = 'warning', category = 'http', source = 'backend', statusCode = null, method = null, path = null, message = 'Error interno', metadata = {} }) => {
  try {
    await supabase.from('system_events').insert({
      severidad: ['info', 'warning', 'critical'].includes(severity) ? severity : 'warning',
      categoria: String(category || 'http').slice(0, 80),
      fuente: String(source || 'backend').slice(0, 80),
      http_status: statusCode,
      metodo: method ? String(method).slice(0, 12) : null,
      ruta: path ? String(path).split('?')[0].slice(0, 240) : null,
      mensaje: String(message || 'Error interno').slice(0, 500),
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
    });
  } catch (_error) {
    // El monitor nunca debe provocar un fallo adicional en la aplicación.
  }
};

const requestFailureRecorder = (req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (res.statusCode < 500) return;
    void recordSystemEvent({
      severity: res.statusCode >= 503 ? 'critical' : 'warning',
      category: 'http_5xx',
      source: 'backend',
      statusCode: res.statusCode,
      method: req.method,
      path: req.originalUrl,
      message: `Solicitud ${req.method} finalizó con HTTP ${res.statusCode}`,
      metadata: { duration_ms: Date.now() - started },
    });
  });
  next();
};

const getSystemMonitorSnapshot = async () => {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const since15m = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const now = new Date();
  const inFiveDays = new Date(now.getTime() + 5 * 86400000).toISOString();

  const [database, auth, storage, frontend, brevo, evolution, eventsResult, recentEventsResult, preResult, privacyResult] = await Promise.all([
    checkDatabase(), checkAuth(), checkStorage(), checkFrontend(), checkBrevo(), checkEvolution(),
    supabase.from('system_events').select('id', { count: 'exact', head: true }).gte('created_at', since24h).gte('http_status', 500),
    supabase.from('system_events').select('*').gte('created_at', since24h).order('created_at', { ascending: false }).limit(40),
    supabase.from('prematriculas').select('id,academia_id,estado,created_at', { count: 'exact' }).eq('estado', 'error').gte('created_at', since24h).limit(20),
    supabase.from('solicitudes_privacidad').select('id,academia_id,tipo,estado,fecha_limite,fecha_limite_prorrogada,fecha_recepcion').not('estado', 'in', '(ejecutada,cerrada,rechazada)').limit(200),
  ]);

  const { count: recent5xxCount } = await supabase.from('system_events').select('id', { count: 'exact', head: true })
    .gte('created_at', since15m).gte('http_status', 500);

  const memory = process.memoryUsage();
  const rssMb = Math.round(memory.rss / MB);
  const heapMb = Math.round(memory.heapUsed / MB);
  const memoryPercent = Math.round((rssMb / memoryLimitMb) * 100);
  const memoryStatus = memoryPercent >= 85 ? 'critical' : memoryPercent >= 70 ? 'warning' : 'ok';

  const privacyRows = privacyResult.data || [];
  const overduePrivacy = privacyRows.filter((row) => new Date(row.fecha_limite_prorrogada || row.fecha_limite) < now).length;
  const dueSoonPrivacy = privacyRows.filter((row) => {
    const deadline = new Date(row.fecha_limite_prorrogada || row.fecha_limite);
    return deadline >= now && deadline <= new Date(inFiveDays);
  }).length;

  const components = [
    { key: 'backend', label: 'Backend Render', status: memoryStatus === 'critical' ? 'warning' : 'ok', detail: `Activo hace ${Math.round(process.uptime() / 60)} min`, metrics: { memory_rss_mb: rssMb, heap_used_mb: heapMb, memory_limit_mb: memoryLimitMb, memory_percent: memoryPercent, commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) || null } },
    { key: 'database', label: 'Supabase Database', status: statusFrom(database.ok, database.ok && database.latency_ms > 500), detail: database.ok ? `${database.latency_ms} ms` : database.error, metrics: database.value || {} },
    { key: 'auth', label: 'Supabase Auth', status: statusFrom(auth.ok, auth.ok && auth.latency_ms > 700), detail: auth.ok ? `${auth.latency_ms} ms` : auth.error, metrics: auth.value || {} },
    { key: 'storage', label: 'Supabase Storage', status: statusFrom(storage.ok && (storage.value || []).every((item) => item.ok)), detail: storage.ok ? `${storage.latency_ms} ms` : storage.error, metrics: { buckets: storage.value || [] } },
    { key: 'frontend', label: 'Frontend Vercel', status: statusFrom(frontend.ok, frontend.ok && frontend.latency_ms > 1200), detail: frontend.ok ? `${frontend.latency_ms} ms` : frontend.error, metrics: frontend.value || {} },
    { key: 'email', label: 'Correo Brevo', status: statusFrom(brevo.ok), detail: brevo.ok ? `${brevo.latency_ms} ms` : brevo.error, metrics: brevo.value || {} },
    { key: 'whatsapp', label: 'WhatsApp Evolution', status: statusFrom(evolution.ok), detail: evolution.ok ? `${evolution.latency_ms} ms` : evolution.error, metrics: evolution.value || {} },
  ];

  const configuration = [
    ['MFA Superadmin', process.env.SUPERADMIN_MFA_ENFORCE === 'true'],
    ['Secreto webhook WhatsApp', String(process.env.WHATSAPP_WEBHOOK_SECRET || '').length >= 32],
    ['Supabase service role', Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)],
    ['Brevo', Boolean(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL)],
    ['Evolution API', Boolean(process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY)],
    ['Mercado Pago', /^https:\/\/link\.mercadopago\.cl\//i.test(String(process.env.MERCADO_PAGO_PAYMENT_LINK || ''))],
    ['Frontend URL', /^https:\/\//i.test(frontendUrl)],
  ].map(([label, configured]) => ({ label, configured: Boolean(configured) }));

  const alerts = [];
  if (memoryStatus !== 'ok') alerts.push({ severity: memoryStatus, type: 'memory', message: `Backend usando ${memoryPercent}% de la memoria configurada (${rssMb}/${memoryLimitMb} MB).` });
  if (Number(recent5xxCount || 0) > 0) alerts.push({ severity: Number(recent5xxCount) >= 5 ? 'critical' : 'warning', type: 'http_5xx', message: `${recent5xxCount} error(es) HTTP 5xx en los últimos 15 minutos.` });
  if (Number(preResult.count || 0) > 0) alerts.push({ severity: Number(preResult.count) >= 5 ? 'warning' : 'info', type: 'prematriculas', message: `${preResult.count} pre-matrícula(s) terminaron en error durante las últimas 24 horas.` });
  if (overduePrivacy > 0) alerts.push({ severity: 'critical', type: 'privacy_overdue', message: `${overduePrivacy} solicitud(es) de privacidad superaron su fecha límite.` });
  else if (dueSoonPrivacy > 0) alerts.push({ severity: 'warning', type: 'privacy_due', message: `${dueSoonPrivacy} solicitud(es) de privacidad vencen dentro de 5 días.` });
  configuration.filter((item) => !item.configured).forEach((item) => alerts.push({ severity: 'warning', type: 'configuration', message: `${item.label} requiere revisión de configuración.` }));
  components.filter((item) => item.status === 'critical').forEach((item) => alerts.push({ severity: 'critical', type: item.key, message: `${item.label}: ${item.detail}` }));
  components.filter((item) => item.status === 'warning').forEach((item) => alerts.push({ severity: 'warning', type: item.key, message: `${item.label}: ${item.detail}` }));

  const overall = alerts.some((item) => item.severity === 'critical') ? 'critical'
    : alerts.some((item) => item.severity === 'warning') ? 'warning' : 'ok';

  return {
    checked_at: new Date().toISOString(),
    overall,
    components,
    configuration,
    alerts,
    operations: {
      http_5xx_24h: Number(eventsResult.count || 0),
      http_5xx_15m: Number(recent5xxCount || 0),
      prematriculas_error_24h: Number(preResult.count || 0),
      privacy_open: privacyRows.length,
      privacy_overdue: overduePrivacy,
      privacy_due_5d: dueSoonPrivacy,
    },
    recent_events: recentEventsResult.data || [],
  };
};

module.exports = { requestFailureRecorder, recordSystemEvent, getSystemMonitorSnapshot };
