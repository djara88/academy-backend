const FALLBACK_ACADEMY_NAME = 'Tu academia';

const normalizeAcademyName = (name) => String(name || '').trim() || FALLBACK_ACADEMY_NAME;

const getAcademyName = async (academyId) => {
  if (!academyId) return FALLBACK_ACADEMY_NAME;
  const supabase = require('../config/supabase');

  const { data, error } = await supabase
    .from('academias')
    .select('nombre')
    .eq('id', academyId)
    .maybeSingle();

  if (error) {
    console.error(`❌ No se pudo cargar la identidad de la academia ${academyId}:`, error.message);
    return FALLBACK_ACADEMY_NAME;
  }

  return normalizeAcademyName(data?.nombre);
};

const academyMessage = (academyName, content) => {
  const name = normalizeAcademyName(academyName);
  return `🏟️ *${name}*\n\n${String(content || '').trim()}\n\n— Equipo de *${name}*`;
};

module.exports = { academyMessage, getAcademyName, normalizeAcademyName };
