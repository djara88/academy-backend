const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
// Obligamos al backend a usar la Service Key
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Faltan variables: SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// Inicializamos el cliente como SUPER ADMIN
// La configuración 'auth' es vital: evita que el backend pierda sus privilegios 
// cuando los profesores inician sesión en el sistema.
const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false
  }
});

module.exports = supabase;
