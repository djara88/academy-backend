const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeJerseyNumber,
  buildJerseyMap,
} = require('../services/jerseyNumbers');

test('normalizeJerseyNumber accepts 1 through 99 and null', () => {
  assert.equal(normalizeJerseyNumber(null), null);
  assert.equal(normalizeJerseyNumber(''), null);
  assert.equal(normalizeJerseyNumber('1'), 1);
  assert.equal(normalizeJerseyNumber(99), 99);
});

test('normalizeJerseyNumber rejects values outside the supported range', () => {
  assert.throws(() => normalizeJerseyNumber(0), { code: 'JERSEY_NUMBER_INVALID' });
  assert.throws(() => normalizeJerseyNumber(100), { code: 'JERSEY_NUMBER_INVALID' });
  assert.throws(() => normalizeJerseyNumber('10.5'), { code: 'JERSEY_NUMBER_INVALID' });
  assert.throws(() => normalizeJerseyNumber('abc'), { code: 'JERSEY_NUMBER_INVALID' });
});

test('buildJerseyMap exposes available, reserved and occupied states', () => {
  const map = buildJerseyMap({
    assigned: [
      { id: 'p1', nombre: 'Jugador Uno', numero: 10 },
      { id: 'p2', nombre: 'Jugador Dos', numero: 10 },
    ],
    reserved: [
      { id: 'pre1', nombre: 'Reserva', numero: 7 },
      { id: 'pre2', nombre: 'Reserva duplicada', numero: 10 },
    ],
  });

  assert.equal(map.numbers.length, 99);
  assert.equal(map.numbers.find((item) => item.number === 1).status, 'available');
  assert.equal(map.numbers.find((item) => item.number === 7).status, 'reserved');
  assert.equal(map.numbers.find((item) => item.number === 10).status, 'occupied');
  assert.equal(map.numbers.find((item) => item.number === 10).occupiedBy.length, 2);
  assert.equal(map.summary.total, 99);
  assert.equal(map.summary.occupied, 1);
  assert.equal(map.summary.reserved, 1);
  assert.equal(map.summary.available, 97);
});
