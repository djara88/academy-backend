const MIN_JERSEY_NUMBER = 1;
const MAX_JERSEY_NUMBER = 99;

const normalizeJerseyNumber = (value) => {
  if (value === '' || value == null) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < MIN_JERSEY_NUMBER || number > MAX_JERSEY_NUMBER) {
    const error = new Error(`El dorsal debe ser un número entre ${MIN_JERSEY_NUMBER} y ${MAX_JERSEY_NUMBER}.`);
    error.status = 400;
    error.code = 'JERSEY_NUMBER_INVALID';
    throw error;
  }
  return number;
};

const buildJerseyMap = ({ assigned = [], reserved = [] } = {}) => {
  const assignedByNumber = new Map();
  const reservedByNumber = new Map();

  for (const item of assigned) {
    const number = normalizeJerseyNumber(item?.numero);
    if (!number) continue;
    const list = assignedByNumber.get(number) || [];
    list.push(item);
    assignedByNumber.set(number, list);
  }

  for (const item of reserved) {
    const number = normalizeJerseyNumber(item?.numero);
    if (!number) continue;
    const list = reservedByNumber.get(number) || [];
    list.push(item);
    reservedByNumber.set(number, list);
  }

  const numbers = [];
  let available = 0;
  let occupied = 0;
  let reservations = 0;

  for (let number = MIN_JERSEY_NUMBER; number <= MAX_JERSEY_NUMBER; number += 1) {
    const holders = assignedByNumber.get(number) || [];
    const requests = reservedByNumber.get(number) || [];
    const status = holders.length ? 'occupied' : requests.length ? 'reserved' : 'available';
    if (status === 'available') available += 1;
    if (status === 'occupied') occupied += 1;
    if (status === 'reserved') reservations += 1;
    numbers.push({
      number,
      status,
      occupiedBy: holders.map((item) => ({ id: item.id || null, name: item.nombre || 'Alumno' })),
      reservedBy: requests.map((item) => ({ id: item.id || null, name: item.nombre || 'Pre-matrícula' })),
    });
  }

  return {
    numbers,
    summary: { total: MAX_JERSEY_NUMBER, available, occupied, reserved: reservations },
  };
};

module.exports = {
  MIN_JERSEY_NUMBER,
  MAX_JERSEY_NUMBER,
  normalizeJerseyNumber,
  buildJerseyMap,
};
