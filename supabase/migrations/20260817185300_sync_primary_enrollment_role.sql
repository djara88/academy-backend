-- Mantiene el rol/posición/especialidad informado en la matrícula dentro del
-- modelo multirrama. `jugadores.posicion_cancha` queda como compatibilidad
-- histórica; `inscripciones_deportivas.rol_especialidad` es la fuente por rama.

create or replace function public.sync_primary_enrollment_role_from_player()
returns trigger
language plpgsql
as $$
begin
  if (new.rol_especialidad is null or btrim(new.rol_especialidad) = '')
     and coalesce(new.es_principal, false) = true then
    select nullif(btrim(j.posicion_cancha), '')
      into new.rol_especialidad
      from public.jugadores j
     where j.id = new.jugador_id
       and j.academia_id = new.academia_id
       and j.rama_id = new.rama_id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sync_primary_enrollment_role_from_player
  on public.inscripciones_deportivas;

create trigger trg_sync_primary_enrollment_role_from_player
before insert or update of jugador_id, rama_id, es_principal, rol_especialidad
on public.inscripciones_deportivas
for each row
execute function public.sync_primary_enrollment_role_from_player();

-- Repara matrículas ya formalizadas que sí conservan la posición en la ficha
-- histórica, pero quedaron sin rol en su inscripción principal.
update public.inscripciones_deportivas i
   set rol_especialidad = nullif(btrim(j.posicion_cancha), ''),
       updated_at = now()
  from public.jugadores j
 where i.jugador_id = j.id
   and i.academia_id = j.academia_id
   and i.rama_id = j.rama_id
   and coalesce(i.es_principal, false) = true
   and (i.rol_especialidad is null or btrim(i.rol_especialidad) = '')
   and nullif(btrim(j.posicion_cancha), '') is not null;
