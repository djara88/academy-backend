const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireTenantContext } = require('../middleware/tenantContext');
const { requireDirector } = require('../middleware/professorAccess');
const { validateFeeChange } = require('../services/feeAdjustmentValidation');

const router = express.Router();
router.use(authMiddleware, requireTenantContext, requireDirector);

const enrollmentColumns = [
  'id', 'jugador_id', 'estado', 'es_principal', 'monto_matricula', 'monto_mensualidad',
  'jugadores(id,nombre)', 'ramas(id,nombre,disciplina)', 'sedes(id,nombre)',
].join(',');

router.get('/', async (req, res) => {
  try {
    const academyId = req.tenant.academyId;
    const pageSize = 500;
    const result = [];
    for (let start = 0; start < 10000; start += pageSize) {
      const { data, error } = await supabase.from('inscripciones_deportivas')
        .select(enrollmentColumns)
        .eq('academia_id', academyId)
        .eq('estado', 'Activa')
        .order('created_at', { ascending: false })
        .range(start, start + pageSize - 1);
      if (error) throw error;
      result.push(...(data || []));
      if ((data || []).length < pageSize) break;
    }
    const data = result.map((row) => ({
      id: row.id,
      jugador_id: row.jugador_id,
      alumno: row.jugadores?.nombre || 'Alumno',
      rama: row.ramas?.nombre || 'Rama deportiva',
      disciplina: row.ramas?.disciplina || '',
      sede: row.sedes?.nombre || 'Sede principal',
      es_principal: row.es_principal === true,
      estado: row.estado,
      monto_matricula: Number(row.monto_matricula || 0),
      monto_mensualidad: Number(row.monto_mensualidad || 0),
    })).sort((a, b) => a.alumno.localeCompare(b.alumno, 'es') || a.rama.localeCompare(b.rama, 'es'));
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error consultando tarifas individuales:', error?.message || error);
    return res.status(500).json({ success: false, error: 'No fue posible consultar las tarifas de los alumnos.' });
  }
});

router.get('/historial', async (req, res) => {
  try {
    const id = String(req.query.inscripcion_id || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ success: false, error: 'Selecciona una inscripción.' });
    const { data, error } = await supabase.from('ajustes_tarifas_deportivas')
      .select('id,inscripcion_id,jugador_id,tipo,monto_anterior,monto_nuevo,motivo,actor_id,cobro_ajustado_id,creado_en')
      .eq('academia_id', req.tenant.academyId)
      .eq('inscripcion_id', id)
      .order('creado_en', { ascending: false })
      .limit(40);
    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (error) {
    console.error('Error leyendo historial de tarifas:', error?.message || error);
    return res.status(500).json({ success: false, error: 'No fue posible obtener el historial de tarifas.' });
  }
});

router.post('/ajustar', async (req, res) => {
  let validated;
  try {
    validated = validateFeeChange(req.body);
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, error: error.message });
  }
  try {
    const { data, error } = await supabase.rpc('ajustar_tarifa_deportiva', {
      p_academia_id: req.tenant.academyId,
      p_jugador_id: validated.jugadorId,
      p_inscripcion_id: validated.inscripcionId,
      p_tipo: validated.tipo,
      p_monto_nuevo: validated.nuevo,
      p_monto_anterior: validated.anterior,
      p_motivo: validated.motivo,
      p_actor_id: String(req.user.id),
      p_aplicar_cobro_actual: validated.aplicarCobroActual,
    });
    if (error) {
      if (error.code === 'P0001') return res.status(409).json({ success: false, error: error.message });
      throw error;
    }
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Error modificando tarifa de inscripción:', error?.message || error);
    return res.status(500).json({ success: false, error: 'No se pudo ajustar la tarifa. No se deben registrar abonos manuales como descuentos.' });
  }
});

module.exports = router;
