const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector } = require('../middleware/professorAccess');
const { todayInChile } = require('../services/monthlyBilling');
const { createSportEnrollment } = require('../services/sportEnrollmentService');

router.use(authMiddleware, requireDirector);

router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase.from('inscripciones_deportivas')
      .select(`id,jugador_id,sede_id,rama_id,categoria_id,estado,fecha_inicio,fecha_fin,monto_matricula,monto_mensualidad,es_principal,created_at,
        jugadores(id,nombre,rut,fecha_nacimiento,foto_url,avatar_url),sedes(id,nombre),ramas(id,nombre,disciplina),categorias(id,nombre)`)
      .eq('academia_id', req.user.academia_id).order('created_at', { ascending: false });
    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (error) {
    console.error('Error cargando inscripciones deportivas:', error?.message || error);
    return res.status(500).json({ success: false, error: 'No fue posible cargar las inscripciones deportivas.' });
  }
});

router.get('/alumnos', async (req, res) => {
  try {
    const [{ data: players, error: playersError }, { data: enrollments, error: enrollmentsError }] = await Promise.all([
      supabase.from('jugadores').select('id,nombre,rut,fecha_nacimiento,foto_url,avatar_url,tutor_id').eq('academia_id', req.user.academia_id).order('nombre'),
      supabase.from('inscripciones_deportivas').select('id,jugador_id,sede_id,rama_id,categoria_id,estado,monto_mensualidad,ramas(nombre,disciplina),sedes(nombre),categorias(nombre)').eq('academia_id', req.user.academia_id).eq('estado', 'Activa'),
    ]);
    if (playersError) throw playersError;
    if (enrollmentsError) throw enrollmentsError;
    const byPlayer = new Map();
    for (const enrollment of enrollments || []) {
      const list = byPlayer.get(enrollment.jugador_id) || [];
      list.push(enrollment); byPlayer.set(enrollment.jugador_id, list);
    }
    return res.json({ success: true, data: (players || []).map((player) => ({ ...player, inscripciones: byPlayer.get(player.id) || [] })) });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'No fue posible cargar los alumnos existentes.' });
  }
});

router.get('/solicitudes', async (req, res) => {
  try {
    const { data, error } = await supabase.from('solicitudes_inscripcion_deportiva')
      .select(`id,estado,mensaje,monto_matricula,abono_matricula,monto_mensualidad,respuesta,created_at,resuelto_at,
        jugadores(id,nombre,rut),tutores(id,nombre_completo,email,telefono),sedes(id,nombre),ramas(id,nombre,disciplina),categorias(id,nombre),inscripcion_id`)
      .eq('academia_id', req.user.academia_id).order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (error) {
    console.error('Error cargando solicitudes deportivas:', error?.message || error);
    return res.status(500).json({ error: 'No fue posible cargar las solicitudes deportivas.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const jugadorId = String(req.body?.jugador_id || '').trim();
    const sedeId = String(req.body?.sede_id || '').trim();
    const ramaId = String(req.body?.rama_id || '').trim();
    const categoriaId = String(req.body?.categoria_id || '').trim() || null;
    if (!jugadorId || !sedeId || !ramaId) return res.status(400).json({ success: false, error: 'Selecciona alumno, sede y rama deportiva.' });
    const data = await createSportEnrollment({
      academiaId: req.user.academia_id, userId: req.user.id, jugadorId, sedeId, ramaId, categoriaId,
      montoMatricula: req.body?.monto_matricula, abonoMatricula: req.body?.abono_matricula, montoMensualidad: req.body?.monto_mensualidad,
      idempotencyKey: req.get('Idempotency-Key'),
    });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return res.status(error?.statusCode || 500).json({ success: false, code: error?.code, error: error?.statusCode ? error.message : 'No fue posible crear la inscripción deportiva.' });
  }
});

router.post('/solicitudes/:id/aprobar', async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const { data: request, error: requestError } = await supabase.from('solicitudes_inscripcion_deportiva')
      .select('*').eq('id', req.params.id).eq('academia_id', academyId).maybeSingle();
    if (requestError) throw requestError;
    if (!request) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    if (request.estado !== 'pendiente') return res.status(409).json({ error: 'Esta solicitud ya fue resuelta.' });

    const data = await createSportEnrollment({
      academiaId: academyId, userId: req.user.id, jugadorId: request.jugador_id, sedeId: request.sede_id, ramaId: request.rama_id,
      categoriaId: String(req.body?.categoria_id || request.categoria_id || '').trim() || null,
      montoMatricula: req.body?.monto_matricula, abonoMatricula: req.body?.abono_matricula, montoMensualidad: req.body?.monto_mensualidad,
      idempotencyKey: `sport-request:${request.id}`,
      solicitudId: request.id,
      respuesta: String(req.body?.respuesta || 'Solicitud aprobada por la academia.').trim().slice(0, 1000),
    });
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error aprobando solicitud deportiva:', error?.message || error);
    return res.status(error?.statusCode || 500).json({ error: error?.statusCode ? error.message : 'No fue posible aprobar la solicitud.', code: error?.code });
  }
});

router.post('/solicitudes/:id/rechazar', async (req, res) => {
  try {
    const { data, error } = await supabase.from('solicitudes_inscripcion_deportiva').update({
      estado: 'rechazada', resuelto_por: req.user.id,
      respuesta: String(req.body?.respuesta || 'Solicitud rechazada por la academia.').trim().slice(0, 1000),
      resuelto_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', req.params.id).eq('academia_id', req.user.academia_id).eq('estado', 'pendiente').select('*').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Solicitud pendiente no encontrada.' });
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ error: 'No fue posible rechazar la solicitud.' });
  }
});

router.patch('/:id/estado', async (req, res) => {
  try {
    const estado = String(req.body?.estado || '').trim();
    if (!['Activa','Inactiva','Retirada'].includes(estado)) return res.status(400).json({ success: false, error: 'Estado de inscripción no válido.' });
    const { data, error } = await supabase.from('inscripciones_deportivas').update({ estado, fecha_fin: estado === 'Activa' ? null : todayInChile(), updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('academia_id', req.user.academia_id).select('*').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Inscripción no encontrada.' });
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'No fue posible actualizar la inscripción.' });
  }
});

module.exports = router;
