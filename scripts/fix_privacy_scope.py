from pathlib import Path
p = Path('services/privacyExecution.js')
s = p.read_text()
old = "  if (academyId && !['jugador_categoria', 'jugador_tutor'].includes(table)) query = query.eq('academia_id', academyId);"
new = "  const scopedByAcademy = new Set(['alertas_asistencia', 'evaluaciones', 'matriculas', 'pedidos_indumentaria']);\n  if (academyId && scopedByAcademy.has(table)) query = query.eq('academia_id', academyId);"
if old not in s:
    raise SystemExit('Patrón deleteRows no encontrado')
p.write_text(s.replace(old, new))
