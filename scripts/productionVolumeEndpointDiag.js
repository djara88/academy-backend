const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const API='https://academy-backend-kqsv.onrender.com';
const FRONTEND='https://academy-frontend-wheat.vercel.app';
const SUPABASE='https://yihcktculicmuuzzxzik.supabase.co';
const suffix=`${Date.now()}-${crypto.randomUUID().slice(0,8)}`;
const email=`syncademia.vdiag.${suffix}@example.com`;
const password=`Vdiag!Aa9-${crypto.randomUUID()}`;
const summary={academy_id:null,auth_user_id:null,site_id:null,branch_id:null,category_id:null,playerCount:0,endpoints:[],writes:null,status:'running'};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const pctl=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s.length?Math.round(s[Math.min(s.length-1,Math.ceil(s.length*p/100)-1)]):0;};
const hdr=(token)=>({'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})});
async function timed(url,opt={},timeout=20000){const c=new AbortController();const timer=setTimeout(()=>c.abort(),timeout);const start=performance.now();try{const r=await fetch(url,{...opt,signal:c.signal});const text=await r.text();let body=null;try{body=text?JSON.parse(text):null}catch{body=text}return{ok:r.ok,status:r.status,ms:performance.now()-start,body};}catch(e){return{ok:false,status:0,ms:performance.now()-start,error:e?.name||String(e)}}finally{clearTimeout(timer)}}
async function expect(url,opt={},codes=[200]){const r=await timed(url,opt);if(!codes.includes(r.status))throw new Error(`${opt.method||'GET'} ${url} -> ${r.status}: ${JSON.stringify(r.body)}`);return r.body;}
const get=(p,t)=>expect(`${API}${p}`,{headers:hdr(t)},[200]);
const post=(p,t,b,c=[200,201])=>expect(`${API}${p}`,{method:'POST',headers:hdr(t),body:JSON.stringify(b)},c);
async function anonKey(){const html=await(await fetch(`${FRONTEND}/`)).text();const asset=html.match(/src="(\/assets\/index-[^"]+\.js)"/i)?.[1];if(!asset)throw new Error('bundle no encontrado');const js=await(await fetch(`${FRONTEND}${asset}`)).text();for(const candidate of (js.match(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g)||[])){try{const p=JSON.parse(Buffer.from(candidate.split('.')[1],'base64url').toString('utf8'));if(p?.ref==='yihcktculicmuuzzxzik'&&p?.role==='anon')return candidate;}catch{}}throw new Error('anon key no encontrada');}
async function bench(path,token,concurrency=20){const rs=await Promise.all(Array.from({length:concurrency},()=>timed(`${API}${path}`,{headers:hdr(token)},20000)));const ms=rs.map(r=>r.ms);const row={path,concurrency,success:rs.filter(r=>r.ok).length,failures:rs.filter(r=>!r.ok).length,fiveXx:rs.filter(r=>r.status>=500).length,p50Ms:pctl(ms,50),p95Ms:pctl(ms,95),p99Ms:pctl(ms,99),maxMs:Math.round(Math.max(...ms)),statuses:rs.reduce((a,r)=>{a[r.status]=(a[r.status]||0)+1;return a;},{})};summary.endpoints.push(row);console.log(`VDIAG_ENDPOINT_JSON=${JSON.stringify(row)}`);return row;}
async function createPlayer(token,index){const u=`${suffix}-${index}`;return timed(`${API}/api/jugadores`,{method:'POST',headers:hdr(token),body:JSON.stringify({tutor:{rut:`VD-T-${u}`,nombre_completo:`Tutor VDiag ${index}`,telefono:'',email:`vd.${u}@example.com`},nombre:`VD Extra ${index}`,rut:`VD-P-${u}`,tipo_alumno:'Nuevo',certificado_medico:'Pendiente',sexo:'Masculino',fecha_nacimiento:'2012-03-10',posicion_cancha:'Base',monto_matricula:10000,abono_matricula:0,monto_mensualidad:25000,foto_base64:null,talla_uniforme:null,talla_apoderado:null,nombre_camiseta:''})},20000);}

(async()=>{try{
  const anon=await anonKey();
  const reg=await post('/api/academias/registro-publico',null,{nombre_academia:`VDIAG200 Syncademia ${suffix}`,nombre_director:'QA VDiag',email,password},[201]);assert.equal(reg?.success,true);summary.academy_id=reg.academia.id;console.log(`VDIAG_ACADEMY_ID=${summary.academy_id}`);
  const auth=await expect(`${SUPABASE}/auth/v1/token?grant_type=password`,{method:'POST',headers:{'content-type':'application/json',apikey:anon},body:JSON.stringify({email,password})},[200]);summary.auth_user_id=auth.user?.id||null;const token=auth.access_token;console.log(`VDIAG_AUTH_USER_ID=${summary.auth_user_id}`);
  const site=await post('/api/estructura/sedes',token,{nombre:'Sede VDiag',codigo:'VD',ciudad:'Santiago',comuna:'Providencia'});summary.site_id=site.data.id;
  const branch=await post('/api/estructura/ramas',token,{sede_id:summary.site_id,nombre:'Básquetbol VDiag',disciplina:'Básquetbol'});summary.branch_id=branch.data.id;
  const cat=await post('/api/jugadores/categorias',token,{rama_id:summary.branch_id,nombre:'U15 VDiag'});summary.category_id=cat.data.id;
  console.log(`VDIAG_CONTEXT_JSON=${JSON.stringify({academy_id:summary.academy_id,site_id:summary.site_id,branch_id:summary.branch_id,category_id:summary.category_id})}`);
  const deadline=Date.now()+90000;while(Date.now()<deadline){const p=await get('/api/jugadores',token);summary.playerCount=(p?.data||[]).length;console.log(`VDIAG_WAIT_PLAYERS=${summary.playerCount}`);if(summary.playerCount>=200)break;await sleep(2500);}assert.ok(summary.playerCount>=200);
  for(const path of ['/api/dashboard/resumen','/api/jugadores','/api/estructura','/api/finanzas/cuentas-corrientes','/api/partidos','/api/academias/mi-plan']){await bench(path,token,20);await sleep(1200);}
  const wr=await Promise.all(Array.from({length:8},(_,i)=>createPlayer(token,i+1)));const ms=wr.map(r=>r.ms);summary.writes={concurrency:8,success:wr.filter(r=>r.ok).length,failures:wr.filter(r=>!r.ok).length,fiveXx:wr.filter(r=>r.status>=500).length,p50Ms:pctl(ms,50),p95Ms:pctl(ms,95),p99Ms:pctl(ms,99),maxMs:Math.round(Math.max(...ms)),statuses:wr.reduce((a,r)=>{a[r.status]=(a[r.status]||0)+1;return a;},{})};console.log(`VDIAG_WRITES_JSON=${JSON.stringify(summary.writes)}`);
  summary.status='success';console.log(`VDIAG_RESULT_JSON=${JSON.stringify(summary)}`);
}catch(e){summary.status='failed';summary.reason=e?.message||String(e);console.error(`VDIAG_FAILURE=${e?.stack||e}`);console.log(`VDIAG_RESULT_JSON=${JSON.stringify(summary)}`);process.exitCode=1;}})();
