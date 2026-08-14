create or replace function public.save_partido_preparacion(
  p_academia_id uuid,
  p_partido_id uuid,
  p_categoria_id uuid,
  p_profesor_id uuid,
  p_sistema_juego text,
  p_objetivo text,
  p_indicaciones text,
  p_hora_citacion time,
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
    academia_id,
    partido_id,
    categoria_id,
    profesor_id,
    sistema_juego,
    objetivo,
    indicaciones,
    hora_citacion,
    estado,
    updated_at
  ) values (
    p_academia_id,
    p_partido_id,
    p_categoria_id,
    p_profesor_id,
    p_sistema_juego,
    p_objetivo,
    p_indicaciones,
    p_hora_citacion,
    p_estado,
    now()
  )
  on conflict (partido_id) do update set
    categoria_id = excluded.categoria_id,
    profesor_id = excluded.profesor_id,
    sistema_juego = excluded.sistema_juego,
    objetivo = excluded.objetivo,
    indicaciones = excluded.indicaciones,
    hora_citacion = excluded.hora_citacion,
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
    preparacion_id,
    jugador_id,
    rol,
    posicion,
    orden,
    updated_at
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
  uuid, uuid, uuid, uuid, text, text, text, time, text, jsonb
) from public, anon, authenticated;

grant execute on function public.save_partido_preparacion(
  uuid, uuid, uuid, uuid, text, text, text, time, text, jsonb
) to service_role;
