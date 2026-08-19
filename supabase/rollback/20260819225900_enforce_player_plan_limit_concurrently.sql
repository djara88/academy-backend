-- Rollback de 20260819225900_enforce_player_plan_limit_concurrently.sql
-- Utilizar únicamente si es necesario revertir la protección atómica de cupos.

drop trigger if exists trg_lestra_enforce_player_plan_limit on public.jugadores;
drop function if exists public.lestra_enforce_player_plan_limit();
