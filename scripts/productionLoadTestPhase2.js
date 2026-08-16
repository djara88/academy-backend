const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const API_BASE = 'https://academy-backend-kqsv.onrender.com';
const SUPABASE_URL = 'https://yihcktculicmuuzzxzik.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlpaGNrdGN1bGljbXV1enp4emlrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyNzA1ODIsImV4cCI6MjEwMDg0NjU4Mn0.ipvbcSacWn3rQhV3_O6Qg2gB7e-xEnSsaQRNADOud7M';
const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const academyName = `LOAD2 Syncademia ${suffix}`;
const email = `syncademia.load2.${suffix}@example.com`;
const password = `Load2!Aa9-${crypto.randomUUID()}`;
const summary = { academy_id: null, auth_user_id: null, reads: [], writes: null, status: 'running' };

const pct = (values, p) => {
  const sorted = [...values].sort((a,b)=>a-b);
  if (!sorted.length) return 0;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);
};
const sleep = (ms) => new Promise((resolve)=>setTimeout(resolve, ms));
const headers = (token) => ({ 'content-type':'application/json', ...(token ? { authorization:`Bearer ${token}` } : {}) });

async function timed(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeoutMs);
  const start = performance.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { ok: response.ok, status: response.status, ms: performance.now()-start, body };
  } catch (error) {
    return { ok:false, status:0, ms:performance.now()-start, error:error?.name || String(error) };
  } finally { clearTimeout(timer); }
}

async function expectJson(url, options = {}, expected = [200]) {
  const r = await timed(url, options);
  if (!expected.includes(r.status)) throw new Error(`${options.method || 'GET'} ${url} -> ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}
const get = (path, token) => expectJson(`${API_BASE}${path}`, { headers: headers(token) }, [200]);
const post = (path, token, body, expected=[200,201]) => expectJson(`${API_BASE}${path}`, { method:'POST', headers:headers(token), body:JSON.stringify(body) }, expected);

async function readStage(concurrency, token) {
  const endpoints = ['/api/dashboard/resumen','/api/jugadores','/api/estructura','/api/finanzas/cuentas-corrientes','/api/partidos','/api/academias/mi-plan'];
  const responses = await Promise.all(Array.from({length:concurrency}, (_,i)=>timed(`${API_BASE}${endpoints[i % endpoints.length]}`, { headers:headers(token) }, 15000)));
  const ms = responses.map(r=>r.ms);
  const failures = responses.filter(r=>!r.ok);
  const stage = {
    concurrency, requests:responses.length, success:responses.length-failures.length, failures:failures.length,
    fiveXx:responses.filter(r=>r.status>=500).length, rateLimited:responses.filter(r=>r.status===429).length,
    p50Ms:pct(ms,50), p95Ms:pct(ms,95), p99Ms:pct(ms,99), maxMs:Math.round(Math.max(...ms)),
    statuses:responses.reduce((a,r)=>{a[r.status]=(a[r.status]||0)+1; return a;},{}),
  };
  summary.reads.push(stage);
  console.log(`PHASE2_READ_JSON=${JSON.stringify(stage)}`);
  if (stage.fiveXx || stage.failures) throw new Error(`reads-${concurrency}: errores detectados`);
  if (stage.p95Ms > 8000) throw new Error(`reads-${concurrency}: p95 ${stage.p95Ms}ms > 8000ms`);
}

async function createPlayer(token, index) {
  const u = `${suffix}-${index}`;
  return timed(`${API_BASE}/api/jugadores`, {
    method:'POST', headers:headers(token), body:JSON.stringify({
      tutor:{ rut:`L2-T-${u}`, nombre_completo:`Apoderado Load2 ${index}`, telefono:'', email:`guardian.load2.${u}@example.com` },
      nombre:`Deportista Load2 ${index}`, rut:`L2-P-${u}`, tipo_alumno:'Nuevo', certificado_medico:'Pendiente',
      sexo:index%2===0?'Masculino':'Femenino', fecha_nacimiento:'2012-03-10', posicion_cancha:'Base',
      monto_matricula:10000, abono_matricula:0, monto_mensualidad:25000, foto_base64:null, talla_uniforme:null, talla_apoderado:null, nombre_camiseta:''
    })
  }, 20000);
}

(async()=>{
  try {
    const registration = await post('/api/academias/registro-publico', null, { nombre_academia:academyName, nombre_director:'QA Load2 Syncademia', email, password }, [201]);
    assert.equal(registration?.success, true);
    summary.academy_id = registration.academia.id;
    console.log(`PHASE2_ACADEMY_ID=${summary.academy_id}`);

    const auth = await expectJson(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method:'POST', headers:{'content-type':'application/json',apikey:SUPABASE_ANON_KEY}, body:JSON.stringify({email,password})
    }, [200]);
    summary.auth_user_id = auth.user?.id || null;
    const token = auth.access_token;

    const site = await post('/api/estructura/sedes', token, { nombre:'Sede Load2', codigo:'L2', ciudad:'Santiago', comuna:'Providencia', ubicacion_entrenamiento:'Recinto Load2' });
    const branch = await post('/api/estructura/ramas', token, { sede_id:site.data.id, nombre:'Básquetbol Load2', disciplina:'Básquetbol', descripcion:'Carga phase2' });
    await post('/api/jugadores/categorias', token, { rama_id:branch.data.id, nombre:'U15 Load2' });
    for (let i=0;i<2;i+=1) await get('/api/dashboard/resumen', token);

    for (const c of [25,50,75]) { await readStage(c, token); await sleep(1500); }

    const writes = await Promise.all(Array.from({length:8}, (_,i)=>createPlayer(token,i+1)));
    const wms = writes.map(r=>r.ms);
    summary.writes = {
      concurrency:8, requests:8, success:writes.filter(r=>r.ok).length, failures:writes.filter(r=>!r.ok).length,
      fiveXx:writes.filter(r=>r.status>=500).length, p50Ms:pct(wms,50), p95Ms:pct(wms,95), p99Ms:pct(wms,99), maxMs:Math.round(Math.max(...wms)),
      statuses:writes.reduce((a,r)=>{a[r.status]=(a[r.status]||0)+1;return a;},{}),
    };
    console.log(`PHASE2_WRITES_JSON=${JSON.stringify(summary.writes)}`);
    if (summary.writes.failures || summary.writes.fiveXx) throw new Error('fase de escrituras con errores');

    const players = await get('/api/jugadores', token);
    assert.equal((players?.data||[]).filter(p=>String(p?.nombre||'').startsWith('Deportista Load2 ')).length,8);
    summary.status='success';
    console.log(`PHASE2_RESULT_JSON=${JSON.stringify(summary)}`);
  } catch (error) {
    summary.status='failed'; summary.reason=error?.message || String(error);
    console.error(`PHASE2_FAILURE=${error?.stack || error}`);
    console.log(`PHASE2_RESULT_JSON=${JSON.stringify(summary)}`);
    process.exitCode=1;
  }
})();
