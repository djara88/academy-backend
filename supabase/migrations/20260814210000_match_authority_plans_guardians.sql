-- La dirección define la programación; el profesor conserva solo la preparación técnica.
alter table public.partidos
  add column if not exists hora_citacion time;

update public.partidos as p
set hora_citacion = pp.hora_citacion
from public.partido_preparaciones as pp
where pp.partido_id = p.id
  and p.hora_citacion is null
  and pp.hora_citacion is not null;

drop function if exists public.save_partido_preparacion(
  uuid, uuid, uuid, uuid, text, text, text, time, text, jsonb
);

alter table public.partido_preparaciones
  drop column if exists hora_citacion;

create or replace function public.save_partido_preparacion(
  p_academia_id uuid,
  p_partido_id uuid,
  p_categoria_id uuid,
  p_profesor_id uuid,
  p_sistema_juego text,
  p_objetivo text,
  p_indicaciones text,
  p_estado text,
  p_jugadores jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_preparacion_id uuid;
begin
  insert into public.partido_preparaciones (
    academia_id, partido_id, categoria_id, profesor_id,
    sistema_juego, objetivo, indicaciones, estado, updated_at
  ) values (
    p_academia_id, p_partido_id, p_categoria_id, p_profesor_id,
    p_sistema_juego, p_objetivo, p_indicaciones, p_estado, now()
  )
  on conflict (partido_id) do update set
    categoria_id = excluded.categoria_id,
    profesor_id = excluded.profesor_id,
    sistema_juego = excluded.sistema_juego,
    objetivo = excluded.objetivo,
    indicaciones = excluded.indicaciones,
    estado = excluded.estado,
    updated_at = now()
  where public.partido_preparaciones.academia_id = excluded.academia_id
  returning id into v_preparacion_id;

  if v_preparacion_id is null then
    raise exception 'El partido no pertenece a la academia indicada.';
  end if;

  delete from public.partido_plan_jugadores
  where preparacion_id = v_preparacion_id;

  insert into public.partido_plan_jugadores (
    preparacion_id, jugador_id, rol, posicion, orden, updated_at
  )
  select
    v_preparacion_id,
    item.jugador_id,
    item.rol,
    coalesce(item.posicion, ''),
    coalesce(item.orden, 0),
    now()
  from jsonb_to_recordset(coalesce(p_jugadores, '[]'::jsonb))
    as item(jugador_id uuid, rol text, posicion text, orden smallint);

  return v_preparacion_id;
end;
$$;

revoke execute on function public.save_partido_preparacion(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.save_partido_preparacion(
  uuid, uuid, uuid, uuid, text, text, text, text, jsonb
) to service_role;

-- Plan comercial base y licencia independiente del portal de apoderados.
alter table public.academias
  add column if not exists plan_codigo text not null default 'formacion',
  add column if not exists licencia_apoderados boolean not null default false;

update public.academias
set plan_codigo = case
  when lower(coalesce(plan, '')) like '%alto rendimiento%'
    or lower(coalesce(plan, '')) like '%elite%' then 'alto_rendimiento'
  when lower(coalesce(plan, '')) like '%competencia%'
    or lower(coalesce(plan, '')) like '%pro%' then 'competencia'
  else 'formacion'
end;

alter table public.academias
  drop constraint if exists academias_plan_codigo_check;
alter table public.academias
  add constraint academias_plan_codigo_check
  check (plan_codigo in ('formacion', 'competencia', 'alto_rendimiento'));

comment on column public.academias.plan_codigo is
  'Plan base contratado: formacion, competencia o alto_rendimiento.';
comment on column public.academias.licencia_apoderados is
  'Add-on independiente que habilita accesos privados para apoderados.';
comment on column public.partidos.hora_citacion is
  'Hora definida exclusivamente por la dirección al programar el partido.';

-- Un tutor puede recibir una cuenta, pero su vínculo sigue perteneciendo a una academia.
alter table public.tutores
  add column if not exists usuario_id uuid references public.usuarios(id) on delete set null,
  add column if not exists acceso_activo boolean not null default false,
  add column if not exists invitado_at timestamptz;

create unique index if not exists tutores_usuario_id_uidx
  on public.tutores (usuario_id) where usuario_id is not null;
create index if not exists tutores_academia_idx
  on public.tutores (academia_id);
create index if not exists jugador_tutor_tutor_idx
  on public.jugador_tutor (tutor_id);
create index if not exists partidos_academia_fecha_idx
  on public.partidos (academia_id, fecha, hora);
create index if not exists entrenamientos_academia_fecha_idx
  on public.entrenamientos (academia_id, fecha);
create index if not exists egresos_academia_fecha_idx
  on public.egresos (academia_id, fecha_gasto);

-- El backend de servicio sigue siendo la única capa que accede a estas columnas privadas.
revoke all on table public.tutores from anon, authenticated;
grant select, insert, update, delete on table public.tutores to service_role;
