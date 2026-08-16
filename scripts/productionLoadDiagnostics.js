const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const API='https://academy-backend-kqsv.onrender.com';
const SUPABASE='https://yihcktculicmuuzzxzik.supabase.co';
const ANON='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlpaGNrdGN1bGljbXV1enp4emlrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyNzA1ODIsImV4cCI6MjEwMDg0NjU4Mn0.ipvbcSacWn3rQhV3_O6Qg2gB7e-xEnSsaQRNADOud7M';
const suffix=`${Date.now()}-${crypto.randomUUID().slice(0,8)}`;
const email=`syncademia.diag.${suffix}@example.com`;
const password=`Diag!Aa9-${crypto.randomUUID()}`;
const summary={academy_id:null,auth_user_id:null,endpoints:[],writes:null,status:'running'};

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const pctl=(arr,p)=>{const a=[...arr].sort((x,y)=>x-y);if(!a.length)return 0;return Math.round(a[Math.min(a.length-1,Math.ceil(a.length*p/100)-1)]);};
const hdr=(token)=>({'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})});
async function timed(url,opt={},timeout=20000){const c=new AbortController();const t=setTimeout(()=>c.abort(),timeout);const s=performance.now();try{const r=await fetch(url,{...opt,signal:c.signal});const txt=await r.text();let body=null;try{body=txt?JSON.parse(txt):null}catch{body=txt}return{ok:r.ok,status:r.status,ms:performance.now()-s,body};}catch(e){return{ok:false,status:0,ms:performance.now()-s,error:e?.name||String(e)}}finally{clearTimeout(t)}}
async function expect(url,opt={},codes=[200]){const r=await timed(url,opt);if(!codes.includes(r.status))throw new Error(`${opt.method||'GET'} ${url} -> ${r.status}: ${JSON.stringify(r.body)}`);return r.body;}
const get=(path,token)=>expect(`${API}${path}`,{headers:hdr(token)},[200]);
const post=(path,token,body,codes=[200,201])=>expect(`${API}${path}`,{method:'POST',headers:hdr(token),body:JSON.stringify(body)},codes);

async function bench(path,token,concurrency=20){
  const responses=await Promise.all(Array.from({length:concurrency},()=>timed(`${API}${path}`,{headers:hdr(token)},15000)));
  const ms=responses.map(r=>r.ms);
  const row={path,concurrency,success:responses.filter(r=>r.ok).length,failures:responses.filter(r=>!r.ok).length,fiveXx:responses.filter(r=>r.status>=500).length,rateLimited:responses.filter(r=>r.status===429).length,p50Ms:pctl(ms,50),p95Ms:pctl(ms,95),p99Ms:pctl(ms,99),maxMs:Math.round(Math.max(...ms)),statuses:responses.reduce((a,r)=>{a[r.status]=(a[r.status]||0)+1;return a;},{})};
  summary.endpoints.push(row);console.log(`DIAG_ENDPOINT_JSON=${JSON.stringify(row)}`);return row;
}

async function createPlayer(token,index){const u=`${suffix}-${index}`;return timed(`${API}/api/jugadores`,{method:'POST',headers:hdr(token),body:JSON.stringify({tutor:{rut:`D-T-${u}`,nombre_completo:`Apoderado Diag ${index}`,telefono:'',email:`guardian.diag.${u}@example.com`},nombre:`Deportista Diag ${index}`,rut:`D-P-${u}`,tipo_alumno:'Nuevo',certificado_medico:'Pendiente',sexo:index%2?'Femenino':'Masculino',fecha_nacimiento:'2012-03-10',posicion_cancha:'Base',monto_matricula:10000,abono_matricula:0,monto_mensualidad:25000,foto_base64:null,talla_uniforme:null,talla_apoderado:null,nombre_camiseta:''})},20000);}

(async()=>{try{
  const reg=await post('/api/academias/registro-publico',null,{nombre_academia:`DIAG Syncademia ${suffix}`,nombre_director:'QA Diagnóstico',email,password},[201]);assert.equal(reg?.success,true);summary.academy_id=reg.academia.id;console.log(`DIAG_ACADEMY_ID=${summary.academy_id}`);
  const auth=await expect(`${SUPABASE}/auth/v1/token?grant_type=password`,{method:'POST',headers:{'content-type':'application/json',apikey:ANON},body:JSON.stringify({email,password})},[200]);summary.auth_user_id=auth.user?.id||null;const token=auth.access_token;
  const site=await post('/api/estructura/sedes',token,{nombre:'Sede Diagnóstico',codigo:'DIAG',ciudad:'Santiago',comuna:'Providencia',ubicacion_entrenamiento:'Recinto Diagnóstico'});
  const branch=await post('/api/estructura/ramas',token,{sede_id:site.data.id,nombre:'Básquetbol Diagnóstico',disciplina:'Básquetbol',descripcion:'Diagnóstico de carga'});
  await post('/api/jugadores/categorias',token,{rama_id:branch.data.id,nombre:'U15 Diagnóstico'});
  await get('/api/dashboard/resumen',token);

  for(const path of ['/api/dashboard/resumen','/api/jugadores','/api/estructura','/api/finanzas/cuentas-corrientes','/api/partidos','/api/academias/mi-plan']){await bench(path,token,20);await sleep(1200);}

  const writes=await Promise.all(Array.from({length:4},(_,i)=>createPlayer(token,i+1)));const ms=writes.map(r=>r.ms);summary.writes={concurrency:4,success:writes.filter(r=>r.ok).length,failures:writes.filter(r=>!r.ok).length,fiveXx:writes.filter(r=>r.status>=500).length,p50Ms:pctl(ms,50),p95Ms:pctl(ms,95),p99Ms:pctl(ms,99),maxMs:Math.round(Math.max(...ms)),statuses:writes.reduce((a,r)=>{a[r.status]=(a[r.status]||0)+1;return a;},{})};console.log(`DIAG_WRITES_JSON=${JSON.stringify(summary.writes)}`);
  summary.status='success';console.log(`DIAG_RESULT_JSON=${JSON.stringify(summary)}`);
}catch(e){summary.status='failed';summary.reason=e?.message||String(e);console.error(`DIAG_FAILURE=${e?.stack||e}`);console.log(`DIAG_RESULT_JSON=${JSON.stringify(summary)}`);process.exitCode=1;}})();
