const { assertJerseyNumberAvailable } = require('../services/jerseyNumbers');

const jerseyReservationGuard = async (req, res, next) => {
  try {
    const player = req.body?.jugador || {};
    const number = player.numero_camiseta;
    if (number === '' || number == null) return next();
    if (!player.rama_id) {
      return res.status(400).json({
        error: 'Selecciona la rama deportiva antes de reservar un dorsal.',
        code: 'JERSEY_BRANCH_REQUIRED',
      });
    }

    await assertJerseyNumberAvailable({
      academyId: req.user.academia_id,
      branchId: player.rama_id,
      categoryId: player.categoria_id || null,
      number,
      excludePrematriculaId: req.params?.id || null,
    });
    return next();
  } catch (error) {
    return res.status(error?.status || 500).json({
      error: error?.message || 'No fue posible validar el dorsal solicitado.',
      code: error?.code || 'JERSEY_VALIDATION_FAILED',
      jersey: error?.jersey || undefined,
    });
  }
};

module.exports = jerseyReservationGuard;
