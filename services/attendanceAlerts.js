const attendanceKey = (trainingId, playerId) => `${trainingId}:${playerId}`;

const countConsecutiveAbsences = (playerId, trainings, attendanceByKey) => {
  let streak = 0;
  for (const training of trainings) {
    if (attendanceByKey.get(attendanceKey(training.id, playerId)) !== 'Ausente') break;
    streak += 1;
  }
  return streak;
};

const buildAttendanceAlertRows = ({
  academyId,
  categoryId,
  playerIds,
  trainings,
  attendance,
  existingAlerts = [],
  now = new Date().toISOString(),
}) => {
  const orderedTrainings = [...trainings].sort((a, b) => (
    String(b.fecha).localeCompare(String(a.fecha)) || String(b.created_at || '').localeCompare(String(a.created_at || ''))
  ));
  const attendanceByKey = new Map(attendance.map((item) => [
    attendanceKey(item.entrenamiento_id, item.jugador_id),
    item.estado,
  ]));
  const existingByPlayer = new Map(existingAlerts.map((item) => [String(item.jugador_id), item]));

  return playerIds.map(String).map((playerId) => {
    const streak = countConsecutiveAbsences(playerId, orderedTrainings, attendanceByKey);
    const existing = existingByPlayer.get(playerId);
    const alreadyReachedThreshold = Number(existing?.racha || 0) >= 3;
    const newlyActivated = streak >= 3 && !alreadyReachedThreshold;

    return {
      academia_id: academyId,
      categoria_id: categoryId,
      jugador_id: playerId,
      tipo: 'ausencias_consecutivas',
      racha: streak,
      activa: newlyActivated || (streak >= 3 && Boolean(existing?.activa)),
      detectada_at: streak >= 3 ? (newlyActivated ? now : existing?.detectada_at || now) : null,
      ultima_ausencia: streak > 0 ? orderedTrainings[0]?.fecha || null : null,
      revisada_at: streak >= 3 && !newlyActivated ? existing?.revisada_at || null : null,
      revisada_por: streak >= 3 && !newlyActivated ? existing?.revisada_por || null : null,
      updated_at: now,
      newly_activated: newlyActivated,
    };
  });
};

module.exports = { buildAttendanceAlertRows, countConsecutiveAbsences };
