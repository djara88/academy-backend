const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const API_BASE = 'https://academy-backend-kqsv.onrender.com';
const SUPABASE_URL = 'https://yihcktculicmuuzzxzik.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlpaGNrdGN1bGljbXV1enp4emlrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyNzA1ODIsImV4cCI6MjEwMDg0NjU4Mn0.ipvbcSacWn3rQhV3_O6Qg2gB7e-xEnSsaQRNADOud7M';

const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const academyName = `LOAD Syncademia ${suffix}`;
const email = `syncademia.load.${suffix}@example.com`;
const password = `Load!Aa9-${crypto.randomUUID()}`;
const result = { academy_id: null, auth_user_id: null, stages: [], writes: null, aborted: false, reason: null };

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
};

const parseBody = async (response) => {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
};

const timedRequest = async (url, options = {}, timeoutMs = 12000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await parseBody(response);
    return { ok: response.ok, status: response.status, ms: performance.now() - started, body };
  } catch (error) {
    return { ok: false, status: 0, ms: performance.now() - started, error: error?.name || String(error) };
  } finally {
    clearTimeout(timer);
  }
};

const jsonHeaders = (token) => ({ 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) });

const requestJson = async (url, options = {}, expected = [200]) => {
  const response = await timedRequest(url, options, 15000);
  if (!expected.includes(response.status)) throw new Error(`${options.method || 'GET'} ${url} -> HTTP ${response.status}: ${JSON.stringify(response.body)}`);
  return response.body;
};

const apiGet = (path, token) => requestJson(`${API_BASE}${path}`, { headers: jsonHeaders(token) }, [200]);
const apiPost = (path, token, body, expected = [200, 201]) => requestJson(`${API_BASE}${path}`, { method: 'POST', headers: jsonHeaders(token), body: JSON.stringify(body) }, expected);

const runReadStage = async (name, concurrency, token) => {
  const endpoints = [
    '/api/dashboard/resumen',
    '/api/jugadores',
    '/api/estructura',
    '/api/finanzas/cuentas-corrientes',
    '/api/partidos',
    '/api/academias/mi-plan',
  ];
  const tasks = Array.from({ length: concurrency }, (_, index) => {
    const path = endpoints[index % endpoints.length];
    return timedRequest(`${API_BASE}${path}`, { headers: jsonHeaders(token) }, 12000).then((response) => ({ ...response, path }));
  });
  const responses = await Promise.all(tasks);
  const durations = responses.map((item) => item.ms);
  const failures = responses.filter((item) => !item.ok);
  const fiveXx = responses.filter((item) => item.status >= 500).length;
  const rateLimited = responses.filter((item) => item.status === 429).length;
  const stage = {
    name,
    concurrency,
    requests: responses.length,
    success: responses.length - failures.length,
    failures: failures.length,
    errorRate: Number(((failures.length / Math.max(1, responses.length)) * 100).toFixed(2)),
    fiveXx,
    rateLimited,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    maxMs: Math.round(Math.max(...durations)),
    statuses: responses.reduce((acc, item) => { acc[item.status] = (acc[item.status] || 0) + 1; return acc; }, {}),
  };
  result.stages.push(stage);
  console.log(`LOAD_STAGE_JSON=${JSON.stringify(stage)}`);

  if (stage.fiveXx > 0) throw new Error(`${name}: apareció al menos un 5xx`);
  if (stage.errorRate > 3) throw new Error(`${name}: error rate ${stage.errorRate}% > 3%`);
  if (stage.p95Ms > 8000) throw new Error(`${name}: p95 ${stage.p95Ms}ms > 8000ms`);
  return stage;
};

const createLoadPlayer = async (token, index) => {
  const unique = `${suffix}-${index}`;
  const started = performance.now();
  const response = await timedRequest(`${API_BASE}/api/jugadores`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({
      tutor: {
        rut: `LOAD-T-${unique}`,
        nombre_completo: `Apoderado Load ${index}`,
        telefono: '',
        email: `guardian.load.${unique}@example.com`,
      },
      nombre: `Deportista Load ${index}`,
      rut: `LOAD-P-${unique}`,
      tipo_alumno: 'Nuevo',
      certificado_medico: 'Pendiente',
      sexo: index % 2 === 0 ? 'Masculino' : 'Femenino',
      fecha_nacimiento: '2012-03-10',
      posicion_cancha: 'Base',
      monto_matricula: 10000,
      abono_matricula: 0,
      monto_mensualidad: 25000,
      foto_base64: null,
      talla_uniforme: null,
      talla_apoderado: null,
      nombre_camiseta: '',
    }),
  }, 15000);
  return { ...response, ms: performance.now() - started };
};

(async () => {
  try {
    console.log('LOAD_STAGE=setup_registration');
    const registration = await apiPost('/api/academias/registro-publico', null, {
      nombre_academia: academyName,
      nombre_director: 'QA Load Syncademia',
      email,
      password,
    }, [201]);
    assert.equal(registration?.success, true);
    result.academy_id = registration.academia.id;
    console.log(`LOAD_ACADEMY_ID=${result.academy_id}`);

    console.log('LOAD_STAGE=setup_auth');
    const auth = await requestJson(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ email, password }),
    }, [200]);
    assert.ok(auth?.access_token);
    result.auth_user_id = auth.user?.id || null;
    const token = auth.access_token;

    console.log('LOAD_STAGE=setup_structure');
    const site = await apiPost('/api/estructura/sedes', token, {
      nombre: 'Sede Load Santiago', codigo: 'LOAD', ciudad: 'Santiago', comuna: 'Providencia', ubicacion_entrenamiento: 'Recinto Load',
    });
    const branch = await apiPost('/api/estructura/ramas', token, {
      sede_id: site.data.id, nombre: 'Básquetbol Load', disciplina: 'Básquetbol', descripcion: 'Rama temporal de prueba de carga',
    });
    const category = await apiPost('/api/jugadores/categorias', token, { rama_id: branch.data.id, nombre: 'U15 Load' });
    assert.ok(category?.data?.id);

    console.log('LOAD_STAGE=baseline_warmup');
    for (let i = 0; i < 3; i += 1) await apiGet('/api/dashboard/resumen', token);

    for (const concurrency of [1, 5, 10, 25, 50, 100]) {
      console.log(`LOAD_STAGE=reads_${concurrency}`);
      await runReadStage(`reads-${concurrency}`, concurrency, token);
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }

    console.log('LOAD_STAGE=writes_8');
    const writeResponses = await Promise.all(Array.from({ length: 8 }, (_, index) => createLoadPlayer(token, index + 1)));
    const writeDurations = writeResponses.map((item) => item.ms);
    const writeFailures = writeResponses.filter((item) => !item.ok);
    result.writes = {
      concurrency: 8,
      requests: 8,
      success: 8 - writeFailures.length,
      failures: writeFailures.length,
      fiveXx: writeResponses.filter((item) => item.status >= 500).length,
      p50Ms: percentile(writeDurations, 50),
      p95Ms: percentile(writeDurations, 95),
      p99Ms: percentile(writeDurations, 99),
      maxMs: Math.round(Math.max(...writeDurations)),
      statuses: writeResponses.reduce((acc, item) => { acc[item.status] = (acc[item.status] || 0) + 1; return acc; }, {}),
    };
    console.log(`LOAD_WRITES_JSON=${JSON.stringify(result.writes)}`);
    if (result.writes.fiveXx > 0 || result.writes.failures > 0) throw new Error('La fase de escrituras tuvo errores');

    console.log('LOAD_STAGE=post_write_check');
    const players = await apiGet('/api/jugadores', token);
    const loadPlayers = (players?.data || []).filter((player) => String(player?.nombre || '').startsWith('Deportista Load '));
    assert.equal(loadPlayers.length, 8);

    console.log(`LOAD_RESULT_JSON=${JSON.stringify({ ...result, status: 'success' })}`);
  } catch (error) {
    result.aborted = true;
    result.reason = error?.message || String(error);
    console.error(`LOAD_FAILURE=${error?.stack || error}`);
    console.log(`LOAD_RESULT_JSON=${JSON.stringify({ ...result, status: 'failed' })}`);
    process.exitCode = 1;
  }
})();
