const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('commit de importación masiva usa una única RPC atómica', () => {
  const source = read('routes/importaciones.js');
  const block = source.match(/router\.post\('\/commit'[\s\S]*?router\.get\('\/lotes'/)?.[0] || '';

  assert.ok(block, 'Debe existir el endpoint de commit y su límite con /lotes');
  assert.match(block, /supabase\.rpc\('commit_player_import_v1'/);
  assert.match(block, /atomicRows/);
  assert.match(block, /atomic:\s*true/);
  assert.doesNotMatch(block, /for\s*\(const row of accepted\)/);
  assert.doesNotMatch(block, /from\('jugadores'\)\.insert/);
  assert.doesNotMatch(block, /from\('inscripciones_deportivas'\)\.insert/);
  assert.doesNotMatch(block, /from\('cobros'\)\.insert/);
});

test('RPC atómica está cerrada a clientes y revierte por excepción', () => {
  const migration = read('supabase/migrations/20261007143450_atomic_player_import_commit_v1.sql');

  assert.match(migration, /create or replace function public\.commit_player_import_v1/i);
  assert.match(migration, /security invoker/i);
  assert.match(migration, /set search_path\s*=\s*''/i);
  assert.match(migration, /set statement_timeout\s*=\s*'90s'/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /insert into public\.jugadores/i);
  assert.match(migration, /insert into public\.inscripciones_deportivas/i);
  assert.match(migration, /update public\.import_lotes[\s\S]*estado\s*=\s*'completado'/i);
  assert.match(migration, /revoke execute[\s\S]*from anon/i);
  assert.match(migration, /revoke execute[\s\S]*from authenticated/i);
  assert.match(migration, /grant execute[\s\S]*to service_role/i);
  assert.doesNotMatch(migration, /exception\s+when\s+others[\s\S]*return/i);
});
