const supabase = require('../config/supabase');
const { enviarMensaje } = require('./whatsappService');
const { academyMessage, getAcademyName } = require('./academyIdentity');

const safeText = (value, max = 180) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const cleanPhone = (value) => String(value || '').replace(/\D/g, '');

const buildRecognitionMessage = ({ academyName, tutorName, studentName, award, branch }) => {
  const emoji = safeText(award?.emoji, 8) || '🏅';
  const awardName = safeText(award?.nombre, 100) || 'Reconocimiento deportivo';
  const description = safeText(award?.descripcion, 240);
  const discipline = safeText(branch?.disciplina || branch?.nombre, 100);
  const branchName = safeText(branch?.nombre, 100);
  const context = [discipline, branchName && branchName !== discipline ? branchName : ''].filter(Boolean).join(' · ');

  return academyMessage(academyName, [
    '🏆 *¡Nuevo reconocimiento deportivo!*',
    '',
    `Hola ${safeText(tutorName, 120) || 'apoderado/a'},`,
    `Queremos contarte que el equipo de *${academyName}* otorgó a *${safeText(studentName, 120) || 'tu alumno/a'}* el siguiente reconocimiento:`,
    '',
    `${emoji} *${awardName}*`,
    context ? `🏃 Disciplina: *${context}*` : '',
    description ? `📝 ${description}` : '',
    '',
    '¡Felicitaciones por su progreso, esfuerzo y compromiso! 🙌',
  ].filter((line) => line !== '').join('\n'));
};

const findAward = (awards, recognitionCode, branchId) => {
  const list = Array.isArray(awards) ? awards : [];
  const matching = list.filter((award) => {
    if (!award || typeof award !== 'object') return false;
    const sameCode = !recognitionCode || String(award.codigo || '') === String(recognitionCode);
    const sameBranch = !branchId || String(award.rama_id || '') === String(branchId);
    return sameCode && sameBranch;
  });
  return matching.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')))[0] || list[0] || null;
};

const notifyRecognitionWhatsapp = async ({ academyId, playerId, recognitionCode, branchId }) => {
  if (!academyId || !playerId) return { sent: false, reason: 'missing_context' };

  const { data: player, error: playerError } = await supabase
    .from('jugadores')
    .select('id,nombre,tutor_id,insignias')
    .eq('id', playerId)
    .eq('academia_id', academyId)
    .maybeSingle();
  if (playerError) throw playerError;
  if (!player?.tutor_id) return { sent: false, reason: 'no_tutor' };

  const award = findAward(player.insignias, recognitionCode, branchId);
  if (!award) return { sent: false, reason: 'award_not_found' };

  const [{ data: tutor, error: tutorError }, { data: enrollment, error: enrollmentError }] = await Promise.all([
    supabase
      .from('tutores')
      .select('id,nombre_completo,telefono')
      .eq('id', player.tutor_id)
      .eq('academia_id', academyId)
      .maybeSingle(),
    branchId
      ? supabase
        .from('inscripciones_deportivas')
        .select('rama_id,ramas(id,nombre,disciplina)')
        .eq('academia_id', academyId)
        .eq('jugador_id', playerId)
        .eq('rama_id', branchId)
        .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (tutorError) throw tutorError;
  if (enrollmentError) throw enrollmentError;

  const phone = cleanPhone(tutor?.telefono);
  if (!phone || phone.length < 8) return { sent: false, reason: 'no_valid_phone' };

  const academyName = await getAcademyName(academyId);
  const message = buildRecognitionMessage({
    academyName,
    tutorName: tutor?.nombre_completo,
    studentName: player.nombre,
    award,
    branch: enrollment?.ramas || null,
  });

  await enviarMensaje(academyId, phone, message);
  return { sent: true };
};

module.exports = {
  buildRecognitionMessage,
  findAward,
  notifyRecognitionWhatsapp,
};
