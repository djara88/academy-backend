const test = require('node:test');
const assert = require('node:assert/strict');
const {
  recordUserPresence,
  samplePresence,
  getPresenceSnapshot,
  resetPresenceForTests,
} = require('../services/userPresence');

test.beforeEach(() => resetPresenceForTests());
test.after(() => resetPresenceForTests());

test('un mismo usuario cuenta una sola vez aunque envíe varios heartbeats', () => {
  const now = 1_000_000;
  recordUserPresence({ id: 'u1', academia_id: 'a1', rol: 'Director' }, now - 20_000);
  recordUserPresence({ id: 'u1', academia_id: 'a1', rol: 'Director' }, now - 5_000);
  const snapshot = getPresenceSnapshot(now);
  assert.equal(snapshot.liveUsers, 1);
  assert.equal(snapshot.activeAcademies, 1);
  assert.equal(snapshot.byRole.director, 1);
});

test('usuarios sin heartbeat durante más de 90 segundos dejan de ser concurrentes', () => {
  const now = 2_000_000;
  recordUserPresence({ id: 'u1', academia_id: 'a1', rol: 'director' }, now - 91_000);
  recordUserPresence({ id: 'u2', academia_id: 'a1', rol: 'profesor' }, now - 10_000);
  const snapshot = getPresenceSnapshot(now);
  assert.equal(snapshot.liveUsers, 1);
  assert.equal(snapshot.byRole.profesor, 1);
  assert.equal(snapshot.byRole.director, undefined);
});

test('promedio y pico usan muestras de la ventana móvil', () => {
  const base = 3_000_000;
  recordUserPresence({ id: 'u1', academia_id: 'a1', rol: 'director' }, base);
  samplePresence(base);

  recordUserPresence({ id: 'u2', academia_id: 'a2', rol: 'profesor' }, base + 30_000);
  samplePresence(base + 30_000);

  recordUserPresence({ id: 'u3', academia_id: 'a2', rol: 'apoderado' }, base + 60_000);
  samplePresence(base + 60_000);

  const snapshot = getPresenceSnapshot(base + 60_000);
  assert.equal(snapshot.liveUsers, 3);
  assert.equal(snapshot.averageUsers15m, 2);
  assert.equal(snapshot.peakUsers15m, 3);
  assert.equal(snapshot.activeAcademies, 2);
  assert.equal(snapshot.averageAcademies15m, 1.7);
});
