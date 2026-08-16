create index if not exists idx_inscripciones_jugador on public.inscripciones_deportivas(jugador_id);
create index if not exists idx_inscripciones_sede on public.inscripciones_deportivas(sede_id);
create index if not exists idx_inscripciones_categoria on public.inscripciones_deportivas(categoria_id) where categoria_id is not null;
