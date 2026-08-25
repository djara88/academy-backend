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
  const body = String(content || '').trim();
  return `🏟️ *${name}*\n🟢 *LESTRA · DEPORTIVO*\n━━━━━━━━━━━━\n\n${body}\n\n━━━━━━━━━━━━\n_Gestión deportiva en un solo lugar_\n— Equipo de *${name}*`;
};

module.exports = { academyMessage, getAcademyName, normalizeAcademyName };
