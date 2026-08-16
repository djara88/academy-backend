const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const API_BASE = 'https://academy-backend-kqsv.onrender.com';
const SUPABASE_URL = 'https://yihcktculicmuuzzxzik.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlpaGNrdGN1bGljbXV1enp4emlrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyNzA1ODIsImV4cCI6MjEwMDg0NjU4Mn0.ipvbcSacWn3rQhV3_O6Qg2gB7e-xEnSsaQRNADOud7M';

const runSuffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const academyName = `E2E Syncademia ${runSuffix}`;
const email = `syncademia.e2e.${runSuffix}@example.com`;
const password = `E2E!Aa9-${crypto.randomUUID()}`;

let context = { academy_id: null, email, academy_name: academyName, player_id: null, match_id: null };

const parseBody = async (response) => {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
};

const request = async (url, options = {}, expected = [200]) => {
  const response = await fetch(url, options);
  const body = await parseBody(response);
  if (!expected.includes(response.status)) {
    const error = new Error(`${options.method || 'GET'} ${url} -> HTTP ${response.status}: ${JSON.stringify(body)}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
};

const api = (path, token, options = {}, expected = [200]) => request(`${API_BASE}${path}`, {
  ...options,
  headers: {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  },
}, expected);

const postJson = (path, token, body, expected = [200, 201]) => api(path, token, { method: 'POST', body: JSON.stringify(body) }, expected);

(async () => {
  try {
    console.log('SMOKE_STAGE=registration');
    const registration = await postJson('/api/academias/registro-publico', null, {
      nombre_academia: academyName,
      nombre_director: 'QA Syncademia',
      email,
      password,
    }, [201]);
    assert.equal(registration?.success, true);
    context.academy_id = registration.academia.id;
    console.log(`SMOKE_ACADEMY_ID=${context.academy_id}`);

    console.log('SMOKE_STAGE=authentication');
    const auth = await request(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ email, password }),
    }, [200]);
    assert.ok(auth?.access_token, 'Supabase no devolvió access_token');
    const token = auth.access_token;

    console.log('SMOKE_STAGE=trial');
    const plan = await api('/api/academias/mi-plan', token);
    assert.equal(plan?.success, true);
    assert.equal(plan?.data?.subscription?.status, 'trialing');

    console.log('SMOKE_STAGE=structure');
    const site = await postJson('/api/estructura/sedes', token, {
      nombre: 'Sede E2E Santiago',
      codigo: 'E2E',
      ciudad: 'Santiago',
      comuna: 'Providencia',
      ubicacion_entrenamiento: 'Recinto E2E',
    });
    assert.ok(site?.data?.id);
    const siteId = site.data.id;

    const branch = await postJson('/api/estructura/ramas', token, {
      sede_id: siteId,
      nombre: 'Básquetbol E2E',
      disciplina: 'Básquetbol',
      descripcion: 'Rama temporal de smoke productivo',
    });
    assert.ok(branch?.data?.id);
    const branchId = branch.data.id;

    console.log('SMOKE_STAGE=category_legacy_compatibility');
    const category = await postJson('/api/jugadores/categorias', token, { nombre: 'U15 E2E' });
    assert.equal(category?.data?.sede_id, siteId);
    assert.equal(category?.data?.rama_id, branchId);
    const categoryId = category.data.id;

    console.log('SMOKE_STAGE=enrollment_and_finance');
    const player = await postJson('/api/jugadores', token, {
      tutor: {
        rut: `TUTOR-${runSuffix}`,
        nombre_completo: 'Apoderado E2E',
        telefono: '',
        email: `guardian.${runSuffix}@example.com`,
      },
      nombre: 'Jugador E2E Básquetbol',
      rut: `PLAYER-${runSuffix}`,
      tipo_alumno: 'Nuevo',
      certificado_medico: 'Pendiente',
      sexo: 'Masculino',
      fecha_nacimiento: '2012-03-10',
      posicion_cancha: 'Base',
      monto_matricula: 10000,
      abono_matricula: 0,
      monto_mensualidad: 25000,
      foto_base64: null,
      talla_uniforme: null,
      talla_apoderado: null,
      nombre_camiseta: '',
    });
    assert.ok(player?.jugador_id);
    const playerId = player.jugador_id;
    context.player_id = playerId;

    const assignment = await postJson(`/api/jugadores/${playerId}/categorias`, token, { categoria_id: categoryId });
    assert.equal(assignment?.data?.player?.sede_id, siteId);
    assert.equal(assignment?.data?.player?.rama_id, branchId);

    const players = await api('/api/jugadores', token);
    const createdPlayer = (players?.data || []).find((item) => item.id === playerId);
    assert.ok(createdPlayer, 'El deportista creado no aparece en GET /api/jugadores');
    assert.equal(createdPlayer.rama_id, branchId);

    const accounts = await api('/api/finanzas/cuentas-corrientes', token);
    const playerAccount = (accounts?.data || []).find((item) => item.id === playerId);
    assert.ok(playerAccount, 'No se creó cuenta corriente para el deportista');
    const chargeTypes = new Set((playerAccount.cobros || []).map((charge) => charge.tipo_concepto));
    assert.ok(chargeTypes.has('Matrícula'), 'Falta cobro de matrícula');
    assert.ok(chargeTypes.has('Mensualidad'), 'Falta cobro de mensualidad');

    console.log('SMOKE_STAGE=multisport_match');
    const match = await postJson('/api/partidos', token, {
      categoria_id: categoryId,
      es_amistoso: true,
      torneo_id: null,
      rival: 'Club E2E',
      fecha: '2026-09-01',
      hora: '18:00',
      hora_citacion: '17:00',
      ubicacion: 'Gimnasio E2E',
      link_maps: '',
      color_uniforme: 'Titular',
      condicion: 'Local',
      cobra_arbitraje: false,
      monto_arbitraje_jugador: 0,
    });
    assert.ok(match?.data?.id);
    assert.equal(match?.data?.sport_profile?.code, 'basquetbol');
    assert.equal(match?.data?.rama_id, branchId);
    const matchId = match.data.id;
    context.match_id = matchId;

    console.log('SMOKE_STAGE=competitive_stats');
    const savedResult = await postJson(`/api/partidos/${matchId}/guardar-resultado`, token, {
      resultado_favor: 72,
      resultado_contra: 61,
      estadisticas: [{
        jugador_id: playerId,
        metricas_competitivas: {
          puntos: 18,
          rebotes: 7,
          asistencias: 5,
          robos: 2,
          tapones: 1,
          triples: 3,
        },
        es_mvp: true,
      }],
      enviarWhatsapp: false,
    });
    assert.equal(savedResult?.success, true);
    assert.equal(savedResult?.profile?.code, 'basquetbol');

    const competitive = await api(`/api/sport-profiles/player/${playerId}/competitive-stats`, token);
    assert.equal(competitive?.data?.code, 'basquetbol');
    assert.equal(competitive?.data?.participations, 1);
    assert.equal(competitive?.data?.mvp, 1);
    const metrics = Object.fromEntries((competitive?.data?.metrics || []).map((metric) => [metric.code, metric.value]));
    assert.equal(metrics.puntos, 18);
    assert.equal(metrics.rebotes, 7);
    assert.equal(metrics.asistencias, 5);
    assert.equal(metrics.triples, 3);

    const matches = await api('/api/partidos', token);
    const createdMatch = (matches?.data || []).find((item) => item.id === matchId);
    assert.equal(createdMatch?.sport_profile?.code, 'basquetbol');
    assert.equal(createdMatch?.estado, 'Jugado');

    console.log('SMOKE_STAGE=completed');
    console.log(`SMOKE_RESULT_JSON=${JSON.stringify({ ...context, status: 'success' })}`);
  } catch (error) {
    console.error(`SMOKE_FAILURE=${error.stack || error.message}`);
    console.log(`SMOKE_RESULT_JSON=${JSON.stringify({ ...context, status: 'failed' })}`);
    process.exitCode = 1;
  }
})();
