const express = require('express');
const supabase = require('../config/supabase');
const authMiddleware = require('../middleware/auth');
const { requireDirector, requireProfessor } = require('../middleware/professorAccess');
const { getProfessorLimit } = require('../services/planLimits');

const router = express.Router();

const uniqueIds = (values) => [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
const todayInChile = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const addDays = (date, days) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const usage = async (academyId) => {
  const [{ data: academy, error: academyError }, { count, error: countError }] = await Promise.all([
    supabase.from('academias').select('id,nombre,plan,max_profesores').eq('id', academyId).single(),
    supabase.from('usuarios').select('id', { count: 'exact', head: true }).eq('academia_id', academyId).eq('rol', 'profesor').eq('activo', true),
  ]);
  if (academyError) throw academyError;
  if (countError) throw countError;
  const max = getProfessorLimit(academy);
  return { academy, used: count || 0, max, remaining: Math.max(max - (count || 0), 0) };
};

router.get('/', authMiddleware, requireDirector, async (req, res) => {
  try {
    const academyId = req.user.academia_id;
    const currentUsage = await usage(academyId);
    const [{ data: professors, error: professorError }, { data: categories, error: categoryError }, { data: assignments, error: assignmentError }] = await Promise.all([
      supabase.from('usuarios').select('id,nombre_completo,email,telefono,activo,ultimo_acceso,created_at')
        .eq('academia_id', academyId).eq('rol', 'profesor').order('created_at'),
      supabase.from('categorias')
        .select('id,nombre,descripcion,sede_id,rama_id,ramas(id,nombre,disciplina),sedes(id,nombre)')
        .eq('academia_id', academyId).order('rama_id').order('nombre'),
      supabase.from('profesor_categorias').select('id,profesor_id,categoria_id,activo')
        .eq('academia_id', academyId).eq('activo', true),
    ]);
    if (professorError) throw professorError;
    if (categoryError) throw categoryError;
    if (assignmentError) throw assignmentError;
    const categoryMap = new Map((categories || []).map((category) => [String(category.id), category]));
    const data = (professors || []).map((professor) => ({
      ...professor,
      categorias: (assignments || []).filter((item) => String(item.profesor_id) === String(professor.id))
        .map((item) => categoryMap.get(String(item.categoria_id))).filter(Boolean),
    }));
    return res.json({
      success: true,
      data,
      categorias: categories || [],
      cupos: { used: currentUsage.used, max: currentUsage.max, remaining: currentUsage.remaining },
      plan: currentUsage.academy.plan,
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'No fue posible cargar profesores.' });
  }
});

router.get('/me', authMiddleware, requireProfessor, async (req, res) => {
  try {
    const [{ data: academy, error: academyError }, { data: assignments, error: assignmentError }] = await Promise.all([
      supabase.from('academias').select('id,nombre,logo,logo_url,rama_principal_id').eq('id', req.user.academia_id).single(),
      supabase.from('profesor_categorias')
        .select('categoria_id,categorias(id,nombre,descripcion,sede_id,rama_id,ramas(id,nombre,disciplina),sedes(id,nombre))')
        .eq('academia_id', req.user.academia_id).eq('profesor_id', req.user.id).eq('activo', true),
    ]);
    if (academyError) throw academyError;
    if (assignmentError) throw assignmentError;
    return res.json({ success: true, data: {
      profesor: { id: req.user.id, nombre: req.user.nombre_completo },
      academia: academy,
      categorias: (assignments || []).map((item) => item.categorias).filter(Boolean),
    } });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'No fue posible cargar el portal del profesor.' });
  }
});

router.get('/me/agenda', authMiddleware, requireProfessor, async (req, res) => {
  try {
    const from = String(req.query?.desde || todayInChile());
    const to = String(req.query?.hasta || addDays(from, 60));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from || to > addDays(from, 120)) {
      return res.status(400).json({ error: 'El rango de agenda es inválido o supera 120 días.' });
    }
    const { data: assignments, error: assignmentError } = await supabase.from('profesor_categorias').select('categoria_id')
      .eq('academia_id', req.user.academia_id).eq('profesor_id', req.user.id).eq('activo', true);
    if (assignmentError) throw assignmentError;
    const categoryIds = uniqueIds((assignments || []).map((item) => item.categoria_id));
    if (!categoryIds.length) return res.json({ success: true, data: [] });

    const [{ data: trainings, error: trainingError }, { data: matches, error: matchError }] = await Promise.all([
      supabase.from('entrenamientos')
        .select('id,categoria_id,sede_id,rama_id,fecha,hora,lugar,estado,es_recuperacion,categorias(id,nombre),ramas(id,nombre,disciplina),sedes(id,nombre)')
        .eq('academia_id', req.user.academia_id).in('categoria_id', categoryIds).gte('fecha', from).lte('fecha', to).order('fecha').order('hora'),
      supabase.from('partidos')
        .select('id,categoria_id,sede_id,rama_id,rival,fecha,hora,hora_citacion,ubicacion,link_maps,color_uniforme,estado,es_amistoso,condicion,categorias(id,nombre),ramas(id,nombre,disciplina),sedes(id,nombre)')
        .eq('academia_id', req.user.academia_id).in('categoria_id', categoryIds).gte('fecha', from).lte('fecha', to).order('fecha').order('hora'),
    ]);
    if (trainingError) throw trainingError;
    if (matchError) throw matchError;
    const trainingIds = (trainings || []).map((item) => item.id);
    const matchIds = (matches || []).map((item) => item.id);
    const [logs, preparations] = await Promise.all([
      trainingIds.length ? supabase.from('entrenamiento_bitacoras').select('entrenamiento_id').eq('academia_id', req.user.academia_id).in('entrenamiento_id', trainingIds) : Promise.resolve({ data: [], error: null }),
      matchIds.length ? supabase.from('partido_preparaciones').select('partido_id,estado').eq('academia_id', req.user.academia_id).in('partido_id', matchIds) : Promise.resolve({ data: [], error: null }),
    ]);
    if (logs.error) throw logs.error;
    if (preparations.error) throw preparations.error;
    const logged = new Set((logs.data || []).map((item) => String(item.entrenamiento_id)));
    const prepMap = new Map((preparations.data || []).map((item) => [String(item.partido_id), item.estado]));
    const events = [
      ...(trainings || []).map((item) => ({ ...item, tipo: 'Entrenamiento', bitacora_completa: logged.has(String(item.id)) })),
      ...(matches || []).map((item) => ({ ...item, tipo: 'Partido', preparacion_estado: prepMap.get(String(item.id)) || null })),
    ].sort((a,b) => `${a.fecha} ${a.hora || ''}`.localeCompare(`${b.fecha} ${b.hora || ''}`));
    return res.json({ success: true, data: events, rango: { desde: from, hasta: to } });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'No fue posible cargar la agenda.' });
  }
});

module.exports = router;
