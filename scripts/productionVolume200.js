const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const API = 'https://academy-backend-kqsv.onrender.com';
const FRONTEND = 'https://academy-frontend-wheat.vercel.app';
const SUPABASE = 'https://yihcktculicmuuzzxzik.supabase.co';
const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const email = `syncademia.volume.${suffix}@example.com`;
const password = `Volume!Aa9-${crypto.randomUUID()}`;
const summary = { academy_id: null, auth_user_id: null, site_id: null, branch_id: null, category_id: null, playerCount: 0, stages: [], writes: null, status: 'running' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((sorted.length * p) / 100) - 1)]);
};
const headers = (token) => ({ 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) });

async function timed(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { ok: response.ok, status: response.status, ms: performance.now() - start, body };
  } catch (error) {
    return { ok: false, status: 0, ms: performance.now() - start, error: error?.name || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function expectJson(url, options = {}, expected = [200]) {
  const response = await timed(url, options);
  if (!expected.includes(response.status)) throw new Error(`${options.method || 'GET'} ${url} -> ${response.status}: ${JSON.stringify(response.body)}`);
  return response.body;
}
const get = (path, token) => expectJson(`${API}${path}`, { headers: headers(token) }, [200]);
const post = (path, token, body, expected = [200, 201]) => expectJson(`${API}${path}`, { method: 'POST', headers: headers(token), body: JSON.stringify(body) }, expected);

async function discoverAnonKey() {
  const html = await (await fetch(`${FRONTEND}/`)).text();
  const asset = html.match(/src="(\/assets\/index-[^"]+\.js)"/i)?.[1];
  if (!asset) throw new Error('No se encontró el bundle principal del frontend.');
  const js = await (await fetch(`${FRONTEND}${asset}`)).text();
  const candidates = js.match(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g) || [];
  const key = candidates.find((candidate) => {
    try {
      const payload = JSON.parse(Buffer.from(candidate.split('.')[1], 'base64url').toString('utf8'));
      return payload?.ref === 'yihcktculicmuuzzxzik' && payload?.role === 'anon';
    } catch { return false; }
  });
  if (!key) throw new Error('No se pudo descubrir la anon key pública del frontend.');
  return key;
}

async function mixedStage(concurrency, token) {
  const endpoints = ['/api/dashboard/resumen', '/api/jugadores', '/api/estructura', '/api/finanzas/cuentas-corrientes', '/api/partidos', '/api/academias/mi-plan'];
  const responses = await Promise.all(Array.from({ length: concurrency }, (_, index) => timed(`${API}${endpoints[index % endpoints.length]}`, { headers: headers(token) }, 20000)));
  const durations = responses.map((item) => item.ms);
  const row = {
    concurrency,
    requests: responses.length,
    success: responses.filter((item) => item.ok).length,
    failures: responses.filter((item) => !item.ok).length,
    fiveXx: responses.filter((item) => item.status >= 500).length,
    rateLimited: responses.filter((item) => item.status === 429).length,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    maxMs: Math.round(Math.max(...durations)),
    statuses: responses.reduce((acc, item) => { acc[item.status] = (acc[item.status] || 0) + 1; return acc; }, {}),
  };
  summary.stages.push(row);
  console.log(`VOLUME_STAGE_JSON=${JSON.stringify(row)}`);
  if (row.failures || row.fiveXx) throw new Error(`mixed-${concurrency}: errores detectados`);
  if (row.p95Ms > 8000) throw new Error(`mixed-${concurrency}: p95 ${row.p95Ms}ms > 8000ms`);
}

async function createPlayer(token, index) {
  const unique = `${suffix}-extra-${index}`;
  return timed(`${API}/api/jugadores`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      tutor: { rut: `VOL-XT-${unique}`, nombre_completo: `Tutor Vol Extra ${index}`, telefono: '', email: `vol.extra.${unique}@example.com` },
      nombre: `Vol Extra ${index}`, rut: `VOL-XP-${unique}`, tipo_alumno: 'Nuevo', certificado_medico: 'Pendiente', sexo: 'Masculino',
      fecha_nacimiento: '2012-03-10', posicion_cancha: 'Base', monto_matricula: 10000, abono_matricula: 0, monto_mensualidad: 25000,
      foto_base64: null, talla_uniforme: null, talla_apoderado: null, nombre_camiseta: '',
    }),
  }, 20000);
}

(async () => {
  try {
    const anon = await discoverAnonKey();
    const registration = await post('/api/academias/registro-publico', null, { nombre_academia: `VOLUME200 Syncademia ${suffix}`, nombre_director: 'QA Volume Syncademia', email, password }, [201]);
    assert.equal(registration?.success, true);
    summary.academy_id = registration.academia.id;
    console.log(`VOLUME_ACADEMY_ID=${summary.academy_id}`);

    const auth = await expectJson(`${SUPABASE}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { 'content-type': 'application/json', apikey: anon }, body: JSON.stringify({ email, password }),
    }, [200]);
    summary.auth_user_id = auth.user?.id || null;
    const token = auth.access_token;
    console.log(`VOLUME_AUTH_USER_ID=${summary.auth_user_id}`);

    const site = await post('/api/estructura/sedes', token, { nombre: 'Sede Volume 200', codigo: 'V200', ciudad: 'Santiago', comuna: 'Providencia', ubicacion_entrenamiento: 'Recinto Volume' });
    summary.site_id = site.data.id;
    const branch = await post('/api/estructura/ramas', token, { sede_id: summary.site_id, nombre: 'Básquetbol Volume', disciplina: 'Básquetbol', descripcion: 'Prueba volumen 200' });
    summary.branch_id = branch.data.id;
    const category = await post('/api/jugadores/categorias', token, { rama_id: summary.branch_id, nombre: 'U15 Volume' });
    summary.category_id = category.data.id;
    console.log(`VOLUME_CONTEXT_JSON=${JSON.stringify({ academy_id: summary.academy_id, site_id: summary.site_id, branch_id: summary.branch_id, category_id: summary.category_id })}`);

    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const players = await get('/api/jugadores', token);
      summary.playerCount = (players?.data || []).length;
      console.log(`VOLUME_WAIT_PLAYERS=${summary.playerCount}`);
      if (summary.playerCount >= 200) break;
      await sleep(2500);
    }
    assert.ok(summary.playerCount >= 200, `Se esperaban 200 deportistas y hay ${summary.playerCount}`);

    for (const concurrency of [20, 50, 100]) {
      await mixedStage(concurrency, token);
      await sleep(1500);
    }

    const writes = await Promise.all(Array.from({ length: 8 }, (_, index) => createPlayer(token, index + 1)));
    const durations = writes.map((item) => item.ms);
    summary.writes = {
      concurrency: 8,
      success: writes.filter((item) => item.ok).length,
      failures: writes.filter((item) => !item.ok).length,
      fiveXx: writes.filter((item) => item.status >= 500).length,
      p50Ms: percentile(durations, 50), p95Ms: percentile(durations, 95), p99Ms: percentile(durations, 99), maxMs: Math.round(Math.max(...durations)),
      statuses: writes.reduce((acc, item) => { acc[item.status] = (acc[item.status] || 0) + 1; return acc; }, {}),
    };
    console.log(`VOLUME_WRITES_JSON=${JSON.stringify(summary.writes)}`);
    if (summary.writes.failures || summary.writes.fiveXx) throw new Error('Escrituras con errores');

    summary.status = 'success';
    console.log(`VOLUME_RESULT_JSON=${JSON.stringify(summary)}`);
  } catch (error) {
    summary.status = 'failed';
    summary.reason = error?.message || String(error);
    console.error(`VOLUME_FAILURE=${error?.stack || error}`);
    console.log(`VOLUME_RESULT_JSON=${JSON.stringify(summary)}`);
    process.exitCode = 1;
  }
})();
