create unique index if not exists cobros_matricula_jugador_unique
on public.cobros (academia_id, jugador_id)
where tipo_concepto = 'Matrícula'
  and jugador_id is not null
  and estado <> 'Anulado';
