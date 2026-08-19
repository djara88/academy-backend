create index if not exists idx_deportista_salud_jugador on public.deportista_salud(jugador_id);
create index if not exists idx_deportista_lesiones_jugador on public.deportista_lesiones(jugador_id);
create index if not exists idx_deportista_lesiones_rama on public.deportista_lesiones(rama_id) where rama_id is not null;
create index if not exists idx_deportista_certificados_jugador on public.deportista_certificados_salud(jugador_id);
create index if not exists idx_deportista_disponibilidad_jugador on public.deportista_disponibilidad_historial(jugador_id);
