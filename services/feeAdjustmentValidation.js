const MONEY_LIMIT = 10_000_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalid = (message) => Object.assign(new Error(message), { status: 400 });

const parseMoney = (value, label) => {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
    throw invalid(`Indica ${label} en pesos chilenos.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > MONEY_LIMIT) {
    throw invalid(`${label} debe ser un monto entero entre $0 y $10.000.000.`);
  }
  return number;
};

const validateFeeChange = (body = {}) => {
  const tipo = String(body.tipo || '').trim();
  if (!['mensualidad', 'matricula'].includes(tipo)) throw invalid('Selecciona matrícula o mensualidad.');
  const jugadorId = String(body.jugador_id || '').trim();
  const inscripcionId = String(body.inscripcion_id || '').trim();
  if (!uuidPattern.test(jugadorId) || !uuidPattern.test(inscripcionId)) throw invalid('Selecciona una inscripción válida.');
  const nuevo = parseMoney(body.monto_nuevo, 'El nuevo importe');
  const anterior = parseMoney(body.monto_anterior, 'El importe anterior');
  if (nuevo === anterior) throw invalid('El nuevo importe debe ser distinto del actual.');
  const motivo = String(body.motivo || '').trim();
  if (motivo.length < 8 || motivo.length > 500) throw invalid('Explica el motivo del ajuste (entre 8 y 500 caracteres).');
  if (typeof body.aplicar_cobro_actual !== 'boolean') throw invalid('Debes indicar si deseas ajustar el cobro actual.');
  return { tipo, jugadorId, inscripcionId, nuevo, anterior, motivo, aplicarCobroActual: body.aplicar_cobro_actual };
};

module.exports = { validateFeeChange };
