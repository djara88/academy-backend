const fs = require('node:fs');

const route = fs.readFileSync('routes/importaciones.js', 'utf8');
const migration = fs.readFileSync('supabase/migrations/20261007143450_atomic_player_import_commit_v1.sql', 'utf8');

const commit = route.match(/router\.post\('\/commit'[\s\S]*?router\.get\('\/lotes'/)?.[0] || '';
if (!commit.includes("supabase.rpc('commit_player_import_v1'")) {
  throw new Error('Atomic import audit failed: /commit must call commit_player_import_v1.');
}
for (const forbidden of [
  "from('jugadores').insert",
  "from('inscripciones_deportivas').insert",
  "from('cobros').insert",
  'for (const row of accepted)',
]) {
  if (commit.includes(forbidden)) {
    throw new Error(`Atomic import audit failed: sequential write pattern returned: ${forbidden}`);
  }
}
for (const required of [
  'security invoker',
  "set search_path = ''",
  'pg_advisory_xact_lock',
  'insert into public.jugadores',
  'insert into public.inscripciones_deportivas',
  'grant execute on function public.commit_player_import_v1',
  'to service_role',
]) {
  if (!migration.toLowerCase().includes(required.toLowerCase())) {
    throw new Error(`Atomic import audit failed: migration missing ${required}`);
  }
}
if (!/revoke execute[\s\S]*from anon/i.test(migration) || !/revoke execute[\s\S]*from authenticated/i.test(migration)) {
  throw new Error('Atomic import audit failed: client roles must not execute the import RPC.');
}

console.log('Atomic bulk import security audit passed.');
