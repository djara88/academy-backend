const fs = require('node:fs');

const target = 'scripts/enable-supabase-leaked-password-protection.mjs';
const source = fs.readFileSync(target, 'utf8');

for (const expected of [
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_PROJECT_REF',
  'password_hibp_enabled',
  '/config/auth',
  "request('GET')",
  "request('PATCH', { password_hibp_enabled: true })",
]) {
  if (!source.includes(expected)) {
    throw new Error(`Supabase phase 2 audit failed: missing ${expected} in ${target}.`);
  }
}

if (/sbp_[A-Za-z0-9_-]{20,}/.test(source) || /Bearer\s+[A-Za-z0-9._-]{20,}/.test(source)) {
  throw new Error('Supabase phase 2 audit failed: a Management API credential appears to be hardcoded.');
}

console.log('Supabase phase 2 security audit passed.');
