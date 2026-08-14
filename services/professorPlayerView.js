const cleanOptionalText = (value) => {
  const text = String(value || '').trim();
  return text || null;
};

const toProfessorPlayer = (player = {}) => ({
  id: player.id,
  nombre: player.nombre,
  posicion_cancha: player.posicion_cancha || null,
  posicion_principal: player.posicion_principal || null,
  foto_url: player.foto_url || null,
  avatar_url: player.avatar_url || null,
  alerta_medica: cleanOptionalText(player.alerta_medica),
  telefono_emergencia: cleanOptionalText(
    player.contacto_emergencia_telefono || player.telefono_emergencia,
  ),
});

module.exports = { toProfessorPlayer };
