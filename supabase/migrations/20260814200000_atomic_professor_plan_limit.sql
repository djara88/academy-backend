create or replace function public.enforce_professor_plan_limit()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  professor_limit integer;
  active_professors integer;
begin
  if lower(coalesce(new.rol, '')) <> 'profesor' or new.activo is not true then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext(new.academia_id::text));

  select a.max_profesores
  into professor_limit
  from public.academias as a
  where a.id = new.academia_id;

  select count(*)
  into active_professors
  from public.usuarios as u
  where u.academia_id = new.academia_id
    and lower(coalesce(u.rol, '')) = 'profesor'
    and u.activo is true
    and u.id <> new.id;

  if active_professors >= coalesce(professor_limit, 2) then
    raise exception 'Se alcanzó el límite de profesores del plan contratado.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists usuarios_professor_plan_limit_trigger on public.usuarios;

create trigger usuarios_professor_plan_limit_trigger
before insert or update of academia_id, rol, activo
on public.usuarios
for each row
execute function public.enforce_professor_plan_limit();

revoke all on function public.enforce_professor_plan_limit() from public, anon, authenticated;
