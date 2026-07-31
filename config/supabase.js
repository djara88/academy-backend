const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
// Cambiamos ANON_KEY por SERVICE_ROLE_KEY para saltar las políticas de seguridad (RLS)
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Faltan variables de entorno: SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// Inicializamos Supabase con privilegios de administrador
const supabase = createClient(supabaseUrl, supabaseServiceKey);

module.exports = supabase;
