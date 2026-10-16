const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261016120600_revoke_disabled_user_data_access.sql'), 'utf8');

test('la lectura directa de academias requiere cuenta activa de esa academia', () => {
  assert.match(sql, /alter policy academias_lectura_propia on public\.academias/);
  assert.match(sql, /u\.academia_id = academias\.id/);
  assert.match(sql, /u\.id = \(select auth\.uid\(\)\)/);
  assert.match(sql, /u\.activo is distinct from false/);
});

test('el acceso Realtime a chat no sobrevive a la desactivación ni permite cruce de academias', () => {
  assert.match(sql, /function private\.can_access_chat_conversation/i);
  assert.match(sql, /active_user\.id = auth\.uid\(\)/);
  assert.match(sql, /active_user\.academia_id = c\.academia_id/);
  assert.match(sql, /active_user\.activo is distinct from false/);
  assert.match(sql, /p\.user_id = auth\.uid\(\)/);
  assert.match(sql, /p\.active = true/);
  assert.match(sql, /security definer/i);
});
