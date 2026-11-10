// Al emitir una matrícula, los horarios pertenecen a la sede del deportista,
// no al registro general de la academia (que conserva campos legacy).
const nonEmpty = (...values) => values
  .map((value) => String(value ?? '').trim())
  .find(Boolean) || '';

const fromSchedule = (configured) => {
  const blocks = Array.isArray(configured) ? configured : [];
  const valid = blocks
    .map((item) => ({
      dias: nonEmpty(item?.dias),
      inicio: nonEmpty(item?.inicio),
      fin: nonEmpty(item?.fin),
    }))
    .filter((item) => item.dias || (item.inicio && item.fin));
  return {
    dias: [...new Set(valid.map((block) => block.dias).filter(Boolean))].join(' · '),
    horario: valid
      .map((block) => [
        block.dias ? `${block.dias}:` : null,
        block.inicio && block.fin ? `${block.inicio}–${block.fin}` : null,
      ].filter(Boolean).join(' '))
      .filter(Boolean)
      .join(' | '),
  };
};

const mergeAcademyTraining = (academy = {}, site = null) => {
  if (!site) return { ...academy };
  const blocks = fromSchedule(site.horarios_config);
  return {
    ...academy,
    // Se elige la sede exacta del alumno para evitar utilizar horarios de otras sedes.
    dias_entrenamiento: nonEmpty(site.dias_entrenamiento, blocks.dias, academy.dias_entrenamiento),
    horarios_entrenamiento: nonEmpty(site.horarios_entrenamiento, blocks.horario, academy.horarios_entrenamiento),
    ubicacion_entrenamiento: nonEmpty(site.ubicacion_entrenamiento, site.direccion, academy.ubicacion_entrenamiento, academy.direccion),
  };
};

const siteColumns = 'id,nombre,dias_entrenamiento,horarios_entrenamiento,horarios_config,ubicacion_entrenamiento,direccion,principal';

const academyForEnrollmentPdf = async (db, academy, player = {}) => {
  if (!academy?.id) throw new Error('Academia no informada para el documento.');
  let siteId = player.sede_id || null;

  if (!siteId && player.rama_id) {
    const { data: branch, error } = await db.from('ramas')
      .select('sede_id')
      .eq('academia_id', academy.id)
      .eq('id', player.rama_id)
      .maybeSingle();
    if (error) throw error;
    siteId = branch?.sede_id || null;
  }

  let site = null;
  if (siteId) {
    const { data, error } = await db.from('sedes')
      .select(siteColumns)
      .eq('academia_id', academy.id)
      .eq('id', siteId)
      .maybeSingle();
    if (error) throw error;
    site = data;
  } else {
    // Compatibilidad con matrículas antiguas sin sede; nunca consultar otra academia.
    const { data, error } = await db.from('sedes')
      .select(siteColumns)
      .eq('academia_id', academy.id)
      .order('principal', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    site = data;
  }

  return mergeAcademyTraining(academy, site);
};

module.exports = { academyForEnrollmentPdf, mergeAcademyTraining, fromSchedule };
