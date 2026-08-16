const supabase = require('../config/supabase');

const resolveStructure = async ({ academiaId, sedeId = null, ramaId = null }) => {
  let site = null;
  if (sedeId) {
    const { data, error } = await supabase.from('sedes').select('*').eq('id', sedeId).eq('academia_id', academiaId).eq('activa', true).maybeSingle();
    if (error) throw error;
    if (!data) { const err = new Error('La sede seleccionada no pertenece a la academia o está inactiva.'); err.code = 'INVALID_SITE'; throw err; }
    site = data;
  } else {
    const { data, error } = await supabase.from('sedes').select('*').eq('academia_id', academiaId).eq('principal', true).maybeSingle();
    if (error) throw error;
    site = data || null;
  }

  let branch = null;
  if (ramaId) {
    const { data, error } = await supabase.from('ramas').select('*').eq('id', ramaId).eq('academia_id', academiaId).eq('activa', true).maybeSingle();
    if (error) throw error;
    if (!data || (site && data.sede_id !== site.id)) { const err = new Error('La rama seleccionada no pertenece a la sede indicada o está inactiva.'); err.code = 'INVALID_BRANCH'; throw err; }
    branch = data;
  } else if (site) {
    const { data, error } = await supabase.from('ramas').select('*').eq('sede_id', site.id).eq('principal', true).maybeSingle();
    if (error) throw error;
    branch = data || null;
  }

  return { sede: site, rama: branch, sede_id: site?.id || null, rama_id: branch?.id || null };
};

module.exports = { resolveStructure };
