create index if not exists profesor_categorias_assigned_by_idx
  on public.profesor_categorias (assigned_by);

create index if not exists entrenamientos_registrado_por_idx
  on public.entrenamientos (registrado_por);

create index if not exists asistencias_registrado_por_idx
  on public.asistencias (registrado_por);

create index if not exists asistencias_jugador_idx
  on public.asistencias (jugador_id);
