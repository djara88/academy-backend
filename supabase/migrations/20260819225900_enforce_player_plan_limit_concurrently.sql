-- Impide sobrecupos por carrera concurrente (ej. dos altas simultáneas en 99/100).
-- El backend mantiene sus validaciones amigables; esta es la barrera atómica final.

create or replace function public.lestra_enforce_player_plan_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  academy_plan text;
  academy_plan_code text;
  player_limit integer;
  current_count integer;
begin
  if new.academia_id is null then
    return new;
  end if;

  -- Serializa altas de alumnos por academia sin bloquear academias distintas.
  perform pg_advisory_xact_lock(hashtextextended(new.academia_id::text, 73421));

  select coalesce(plan, ''), coalesce(plan_codigo, '')
    into academy_plan, academy_plan_code
  from public.academias
  where id = new.academia_id;

  if not found then
    return new;
  end if;

  if lower(academy_plan) like '%prueba%'
     or lower(academy_plan) like '%trial%'
     or academy_plan_code = 'alto_rendimiento' then
    return new;
  end if;

  player_limit := case academy_plan_code
    when 'competencia' then 300
    else 100
  end;

  select count(*)
    into current_count
  from public.jugadores
  where academia_id = new.academia_id;

  if current_count >= player_limit then
    raise exception using
      errcode = '23514',
      message = 'PLAYER_LIMIT_REACHED',
      detail = format('La academia alcanzó el máximo de %s alumnos de su plan.', player_limit);
  end if;

  return new;
end;
$$;

revoke all on function public.lestra_enforce_player_plan_limit() from public;
revoke all on function public.lestra_enforce_player_plan_limit() from anon;
revoke all on function public.lestra_enforce_player_plan_limit() from authenticated;

drop trigger if exists trg_lestra_enforce_player_plan_limit on public.jugadores;
create trigger trg_lestra_enforce_player_plan_limit
before insert on public.jugadores
for each row execute function public.lestra_enforce_player_plan_limit();
