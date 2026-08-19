const express = require('express');
const supabase = require('../config/supabase');
const { requireDirector } = require('../middleware/professorAccess');
const { safeText } = require('../services/branchContext');

const router = express.Router();
router.use(requireDirector);

const AVAILABILITY = new Set(['Sin evaluar', 'Disponible', 'Disponible con restricción', 'En recuperación', 'No disponible']);
const INJURY_STATES = new Set(['Activa', 'Recuperación', 'Entrenamiento parcial', 'Entrenamiento completo', 'Cerrada']);
const today = () => new Date().toISOString().slice(0, 10);
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const clean = (value, max = 1500) => {
  const text = safeText(value, max);
  return text || null;
};
const dayDiff = (start, end) => {
  if (!start) return 0;
  const a = new Date(`${String(start).slice(0, 10)}T12:00:00Z`);
  const b = new Date(`${String(end || today()).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b < a) return 0;
  return Math.floor((b.getTime() - a.getTime()) / 86400000) + 1;
};
const radarAverage = (row) => {
  const radar = row?.datos_radar && typeof row.datos_radar === 'object' ? row.datos_radar : {};
  const values = Object.values(radar).map(Number).filter(Number.isFinite);
  if (!values.length) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
};
const certificateStatus = (row) => {
  if (row?.activo === false) return 'Archivado';
  if (!row?.fecha_vencimiento) return 'Sin vencimiento';
  const expiry = new Date(`${row.fecha_vencimiento}T12:00:00Z`);
  const now = new Date(`${today()}T12:00:00Z`);
  const days = Math.ceil((expiry.getTime() - now.getTime()) / 86400000);
  if (days < 0) return 'Vencido';
  if (days <= 30) return 'Por vencer';
  return 'Vigente';
};

const assertPlayer = async (academyId, playerId) => {
  const { data, error } = await supabase.from('jugadores')
    .select('id,nombre,foto_url,foto_base64,avatar_url,fecha_nacimiento,grupo_sanguineo,alergias,medicamentos,enfermedades_cronicas,observaciones_medicas,contacto_emergencia_nombre,contacto_emergencia_telefono,contacto_emergencia_parentesco,contacto_emergencia,telefono_emergencia')
    .eq('id', playerId).eq('academia_id', academyId).maybeSingle();
  if (error) throw error;
  if (!data) {
    const error404 = new Error('Deportista no encontrado.');
    error404.status = 404;
    throw error404;
  }
  return data;
};

router.get('/resumen', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const [{ data: players, error: playerError }, { data: health, error: healthError }, { data: injuries, error: injuryError }, { data: certificates, error: certificateError }] = await Promise.all([
      supabase.from('jugadores').select('id,nombre,foto_url,foto_base64,avatar_url').eq('academia_id', academyId).order('nombre').limit(1000),
      supabase.from('deportista_salud').select('jugador_id,estado_disponibilidad,restriccion,updated_at').eq('academia_id', academyId),
      supabase.from('deportista_lesiones').select('jugador_id,estado,fecha_retorno_estimada').eq('academia_id', academyId).neq('estado', 'Cerrada'),
      supabase.from('deportista_certificados_salud').select('jugador_id,fecha_vencimiento,activo').eq('academia_id', academyId).eq('activo', true),
    ]);
    const failed = [playerError, healthError, injuryError, certificateError].find(Boolean);
    if (failed) throw failed;

    const healthMap = new Map((health || []).map((row) => [String(row.jugador_id), row]));
    const injuryMap = new Map();
    for (const row of injuries || []) {
      const key = String(row.jugador_id);
      if (!injuryMap.has(key)) injuryMap.set(key, []);
      injuryMap.get(key).push(row);
    }
    const certificateMap = new Map();
    for (const row of certificates || []) {
      const key = String(row.jugador_id);
      if (!certificateMap.has(key)) certificateMap.set(key, []);
      certificateMap.get(key).push(row);
    }

    const items = (players || []).map((player) => {
      const profile = healthMap.get(String(player.id));
      const playerInjuries = injuryMap.get(String(player.id)) || [];
      const playerCertificates = certificateMap.get(String(player.id)) || [];
      const statuses = playerCertificates.map(certificateStatus);
      return {
        id: player.id,
        nombre: player.nombre,
        foto: player.foto_url || player.avatar_url || player.foto_base64 || null,
        estado_disponibilidad: profile?.estado_disponibilidad || 'Sin evaluar',
        restriccion: profile?.restriccion || null,
        lesiones_activas: playerInjuries.length,
        retorno_estimado: playerInjuries.map((row) => row.fecha_retorno_estimada).filter(Boolean).sort()[0] || null,
        certificados_vencidos: statuses.filter((value) => value === 'Vencido').length,
        certificados_por_vencer: statuses.filter((value) => value === 'Por vencer').length,
      };
    });

    const counts = Object.fromEntries([...AVAILABILITY].map((status) => [status, items.filter((item) => item.estado_disponibilidad === status).length]));
    return res.json({ success: true, data: { items, resumen: { total: items.length, por_estado: counts, lesiones_activas: (injuries || []).length, certificados_vencidos: items.reduce((sum, item) => sum + item.certificados_vencidos, 0) } } });
  } catch (error) {
    console.error('Error cargando salud deportiva:', error?.message || error);
    return res.status(500).json({ success: false, error: 'No fue posible cargar salud y disponibilidad deportiva.' });
  }
});

router.get('/jugador/:jugadorId', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const playerId = req.params.jugadorId;
    const player = await assertPlayer(academyId, playerId);

    const [healthResult, injuryResult, certificateResult, historyResult, attendanceResult, evaluationResult, enrollmentResult, statsResult, marksResult] = await Promise.all([
      supabase.from('deportista_salud').select('*').eq('academia_id', academyId).eq('jugador_id', playerId).maybeSingle(),
      supabase.from('deportista_lesiones').select('*,ramas(nombre,disciplina)').eq('academia_id', academyId).eq('jugador_id', playerId).order('fecha_inicio', { ascending: false }).limit(100),
      supabase.from('deportista_certificados_salud').select('*').eq('academia_id', academyId).eq('jugador_id', playerId).eq('activo', true).order('created_at', { ascending: false }).limit(50),
      supabase.from('deportista_disponibilidad_historial').select('*').eq('academia_id', academyId).eq('jugador_id', playerId).order('fecha_desde', { ascending: false }).limit(30),
      supabase.from('asistencias').select('estado,created_at').eq('jugador_id', playerId).order('created_at', { ascending: false }).limit(1000),
      supabase.from('evaluaciones').select('id,fecha,fecha_evaluacion,datos_radar,disciplina_codigo,rama_id').eq('academia_id', academyId).eq('jugador_id', playerId).order('fecha_evaluacion', { ascending: false }).order('fecha', { ascending: false }).limit(100),
      supabase.from('inscripciones_deportivas').select('id,estado,es_principal,rama_id,categoria_id,ramas(nombre,disciplina,activa),categorias(nombre)').eq('academia_id', academyId).eq('jugador_id', playerId).order('es_principal', { ascending: false }),
      supabase.from('partido_estadisticas').select('partido_id,participo,titular,minutos,es_mvp,metricas_competitivas,disciplina_codigo').eq('jugador_id', playerId).order('created_at', { ascending: false }).limit(1000),
      supabase.from('deportista_marcas').select('id,rama_id,partido_id,disciplina_codigo,prueba_codigo,prueba_nombre,metrica_label,valor,unidad,comparacion,temporada,fecha,es_pb,es_sb,valor_pb_anterior,valor_sb_anterior').eq('academia_id', academyId).eq('jugador_id', playerId).order('fecha', { ascending: false }).limit(500),
    ]);
    const results = [healthResult, injuryResult, certificateResult, historyResult, attendanceResult, evaluationResult, enrollmentResult, statsResult, marksResult];
    const failed = results.find((result) => result.error);
    if (failed) throw failed.error;

    const rawStats = statsResult.data || [];
    const matchIds = [...new Set(rawStats.map((row) => row.partido_id).filter(Boolean))];
    let validMatchIds = new Set();
    let matches = [];
    if (matchIds.length) {
      const matchResult = await supabase.from('partidos').select('id,fecha,estado,rama_id,disciplina_codigo,prueba_nombre,rival,temporada').eq('academia_id', academyId).in('id', matchIds).limit(1000);
      if (matchResult.error) throw matchResult.error;
      matches = matchResult.data || [];
      validMatchIds = new Set(matches.map((row) => String(row.id)));
    }
    const stats = rawStats.filter((row) => validMatchIds.has(String(row.partido_id)) && row.participo !== false);

    const attendanceRows = attendanceResult.data || [];
    const attended = attendanceRows.filter((row) => String(row.estado || '').toLowerCase() === 'presente').length;
    const attendanceRate = attendanceRows.length ? Math.round((attended / attendanceRows.length) * 1000) / 10 : null;

    const evaluations = evaluationResult.data || [];
    const latestEvaluation = radarAverage(evaluations[0]);
    const previousEvaluation = radarAverage(evaluations[1]);
    const evaluationDelta = latestEvaluation === null || previousEvaluation === null ? null : Math.round((latestEvaluation - previousEvaluation) * 10) / 10;

    const minutes = Math.round(stats.reduce((sum, row) => sum + number(row.minutos), 0) * 10) / 10;
    const marks = marksResult.data || [];
    const injuries = injuryResult.data || [];
    const activeInjuries = injuries.filter((row) => row.estado !== 'Cerrada');
    const yearStart = `${today().slice(0, 4)}-01-01`;
    const daysOutSeason = injuries.reduce((sum, row) => {
      const start = String(row.fecha_inicio || '');
      const end = row.fecha_cierre || today();
      if (!start || String(end) < yearStart) return sum;
      return sum + dayDiff(start < yearStart ? yearStart : start, end);
    }, 0);

    const profile = healthResult.data || {
      academia_id: academyId,
      jugador_id: playerId,
      estado_disponibilidad: 'Sin evaluar',
      restriccion: null,
      grupo_sanguineo: player.grupo_sanguineo || null,
      alergias: player.alergias || null,
      medicamentos: player.medicamentos || null,
      enfermedades_cronicas: player.enfermedades_cronicas || null,
      observaciones: player.observaciones_medicas || null,
      contacto_emergencia_nombre: player.contacto_emergencia_nombre || player.contacto_emergencia || null,
      contacto_emergencia_telefono: player.contacto_emergencia_telefono || player.telefono_emergencia || null,
      contacto_emergencia_parentesco: player.contacto_emergencia_parentesco || null,
    };

    const certificates = (certificateResult.data || []).map((row) => ({ ...row, estado_calculado: certificateStatus(row) }));
    return res.json({
      success: true,
      data: {
        jugador: { id: player.id, nombre: player.nombre, foto: player.foto_url || player.avatar_url || player.foto_base64 || null, fecha_nacimiento: player.fecha_nacimiento },
        salud: profile,
        lesiones: injuries,
        certificados: certificates,
        disponibilidad_historial: historyResult.data || [],
        inscripciones: enrollmentResult.data || [],
        perfil_360: {
          asistencia: { porcentaje: attendanceRate, registros: attendanceRows.length, presentes: attended },
          evaluacion: { promedio_actual: latestEvaluation, variacion: evaluationDelta, evaluaciones: evaluations.length },
          competencia: { eventos: new Set(stats.map((row) => String(row.partido_id))).size, participaciones: stats.length, titularidades: stats.filter((row) => row.titular).length, minutos: minutes, destacados: stats.filter((row) => row.es_mvp).length },
          marcas: { pb_vigentes: marks.filter((row) => row.es_pb).length, sb_vigentes: marks.filter((row) => row.es_sb).length, recientes: marks.slice(0, 8) },
          salud: { estado: profile.estado_disponibilidad || 'Sin evaluar', lesiones_activas: activeInjuries.length, dias_fuera_temporada: daysOutSeason, certificados_vencidos: certificates.filter((row) => row.estado_calculado === 'Vencido').length, certificados_por_vencer: certificates.filter((row) => row.estado_calculado === 'Por vencer').length },
          eventos_recientes: matches.slice(0, 8),
        },
      },
    });
  } catch (error) {
    console.error('Error cargando perfil 360:', error?.message || error);
    return res.status(error.status || 500).json({ success: false, error: error.status === 404 ? error.message : 'No fue posible cargar el Perfil 360 del deportista.' });
  }
});

router.put('/jugador/:jugadorId', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const playerId = req.params.jugadorId;
    await assertPlayer(academyId, playerId);
    const requestedStatus = clean(req.body?.estado_disponibilidad, 60) || 'Sin evaluar';
    if (!AVAILABILITY.has(requestedStatus)) return res.status(400).json({ error: 'Estado de disponibilidad no válido.' });

    const { data: current, error: currentError } = await supabase.from('deportista_salud').select('estado_disponibilidad').eq('academia_id', academyId).eq('jugador_id', playerId).maybeSingle();
    if (currentError) throw currentError;
    const payload = {
      academia_id: academyId,
      jugador_id: playerId,
      estado_disponibilidad: requestedStatus,
      restriccion: clean(req.body?.restriccion),
      grupo_sanguineo: clean(req.body?.grupo_sanguineo, 30),
      alergias: clean(req.body?.alergias),
      medicamentos: clean(req.body?.medicamentos),
      enfermedades_cronicas: clean(req.body?.enfermedades_cronicas),
      observaciones: clean(req.body?.observaciones),
      contacto_emergencia_nombre: clean(req.body?.contacto_emergencia_nombre, 180),
      contacto_emergencia_telefono: clean(req.body?.contacto_emergencia_telefono, 60),
      contacto_emergencia_parentesco: clean(req.body?.contacto_emergencia_parentesco, 80),
      updated_by: req.user.id || null,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from('deportista_salud').upsert(payload, { onConflict: 'academia_id,jugador_id' }).select('*').single();
    if (error) throw error;

    const { error: legacyError } = await supabase.from('jugadores').update({
      grupo_sanguineo: payload.grupo_sanguineo,
      alergias: payload.alergias,
      medicamentos: payload.medicamentos,
      enfermedades_cronicas: payload.enfermedades_cronicas,
      observaciones_medicas: payload.observaciones,
      contacto_emergencia_nombre: payload.contacto_emergencia_nombre,
      contacto_emergencia_telefono: payload.contacto_emergencia_telefono,
      contacto_emergencia_parentesco: payload.contacto_emergencia_parentesco,
    }).eq('id', playerId).eq('academia_id', academyId);
    if (legacyError) throw legacyError;

    if ((current?.estado_disponibilidad || 'Sin evaluar') !== requestedStatus) {
      await supabase.from('deportista_disponibilidad_historial').update({ fecha_hasta: new Date().toISOString() })
        .eq('academia_id', academyId).eq('jugador_id', playerId).is('fecha_hasta', null);
      const historyResult = await supabase.from('deportista_disponibilidad_historial').insert({
        academia_id: academyId,
        jugador_id: playerId,
        estado: requestedStatus,
        motivo: clean(req.body?.motivo_disponibilidad, 300),
        observaciones: clean(req.body?.restriccion),
        created_by: req.user.id || null,
      });
      if (historyResult.error) throw historyResult.error;
    }
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error actualizando salud deportiva:', error?.message || error);
    return res.status(error.status || 500).json({ error: error.status === 404 ? error.message : 'No fue posible actualizar salud y disponibilidad.' });
  }
});

router.post('/jugador/:jugadorId/lesiones', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const playerId = req.params.jugadorId;
    await assertPlayer(academyId, playerId);
    const tipo = clean(req.body?.tipo, 180);
    if (!tipo) return res.status(400).json({ error: 'Indica el tipo o motivo de la incidencia.' });
    const branchId = clean(req.body?.rama_id, 80);
    if (branchId) {
      const { data: branch, error: branchError } = await supabase.from('ramas').select('id').eq('id', branchId).eq('academia_id', academyId).maybeSingle();
      if (branchError) throw branchError;
      if (!branch) return res.status(400).json({ error: 'La rama indicada no pertenece a la academia.' });
    }
    const state = clean(req.body?.estado, 50) || 'Activa';
    if (!INJURY_STATES.has(state)) return res.status(400).json({ error: 'Estado de seguimiento no válido.' });
    const payload = {
      academia_id: academyId,
      jugador_id: playerId,
      rama_id: branchId,
      tipo,
      zona: clean(req.body?.zona, 120),
      descripcion: clean(req.body?.descripcion),
      estado: state,
      fecha_inicio: clean(req.body?.fecha_inicio, 20) || today(),
      fecha_retorno_estimada: clean(req.body?.fecha_retorno_estimada, 20),
      fecha_cierre: state === 'Cerrada' ? (clean(req.body?.fecha_cierre, 20) || today()) : null,
      restriccion: clean(req.body?.restriccion),
      observaciones: clean(req.body?.observaciones),
      created_by: req.user.id || null,
      updated_by: req.user.id || null,
    };
    const { data, error } = await supabase.from('deportista_lesiones').insert(payload).select('*,ramas(nombre,disciplina)').single();
    if (error) throw error;
    return res.status(201).json({ success: true, data });
  } catch (error) {
    console.error('Error registrando seguimiento de salud:', error?.message || error);
    return res.status(error.status || 500).json({ error: error.status === 404 ? error.message : 'No fue posible registrar el seguimiento.' });
  }
});

router.patch('/lesiones/:id', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const { data: current, error: currentError } = await supabase.from('deportista_lesiones').select('*').eq('id', req.params.id).eq('academia_id', academyId).maybeSingle();
    if (currentError) throw currentError;
    if (!current) return res.status(404).json({ error: 'Seguimiento no encontrado.' });
    const state = clean(req.body?.estado, 50) || current.estado;
    if (!INJURY_STATES.has(state)) return res.status(400).json({ error: 'Estado de seguimiento no válido.' });
    const payload = {
      estado: state,
      fecha_retorno_estimada: req.body?.fecha_retorno_estimada === '' ? null : (clean(req.body?.fecha_retorno_estimada, 20) || current.fecha_retorno_estimada),
      fecha_cierre: state === 'Cerrada' ? (clean(req.body?.fecha_cierre, 20) || current.fecha_cierre || today()) : null,
      restriccion: req.body?.restriccion === '' ? null : (clean(req.body?.restriccion) || current.restriccion),
      observaciones: req.body?.observaciones === '' ? null : (clean(req.body?.observaciones) || current.observaciones),
      updated_by: req.user.id || null,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from('deportista_lesiones').update(payload).eq('id', req.params.id).eq('academia_id', academyId).select('*,ramas(nombre,disciplina)').single();
    if (error) throw error;
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error actualizando seguimiento de salud:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible actualizar el seguimiento.' });
  }
});

router.post('/jugador/:jugadorId/certificados', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const playerId = req.params.jugadorId;
    await assertPlayer(academyId, playerId);
    const payload = {
      academia_id: academyId,
      jugador_id: playerId,
      tipo: clean(req.body?.tipo, 180) || 'Certificado médico',
      fecha_emision: clean(req.body?.fecha_emision, 20),
      fecha_vencimiento: clean(req.body?.fecha_vencimiento, 20),
      archivo_url: clean(req.body?.archivo_url, 1200),
      observaciones: clean(req.body?.observaciones),
      created_by: req.user.id || null,
    };
    const { data, error } = await supabase.from('deportista_certificados_salud').insert(payload).select('*').single();
    if (error) throw error;
    return res.status(201).json({ success: true, data: { ...data, estado_calculado: certificateStatus(data) } });
  } catch (error) {
    console.error('Error registrando certificado:', error?.message || error);
    return res.status(error.status || 500).json({ error: error.status === 404 ? error.message : 'No fue posible registrar el certificado.' });
  }
});

module.exports = router;
