create unique index if not exists partido_estadisticas_single_mvp_per_match_idx
  on public.partido_estadisticas (partido_id)
  where es_mvp is true;

create or replace function public.registrar_estadistica_live_v2(
  p_academia_id uuid,
  p_partido_id uuid,
  p_jugador_id uuid,
  p_expected_live_updated_at timestamptz,
  p_asistio boolean,
  p_disciplina_codigo text,
  p_metricas_competitivas jsonb,
  p_metricas_version smallint,
  p_es_mvp boolean,
  p_goles integer,
  p_asistencias integer,
  p_tarjetas_amarillas integer,
  p_tarjetas_rojas integer,
  p_usuario_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match public.partidos%rowtype;
  v_stat public.partido_estadisticas%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_match
  from public.partidos
  where id = p_partido_id
    and academia_id = p_academia_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'code', 'LIVE_MATCH_NOT_FOUND', 'error', 'Encuentro no encontrado.');
  end if;

  if not coalesce(v_match.en_vivo, false) or v_match.estado = 'Jugado' then
    return jsonb_build_object(
      'success', false,
      'code', 'LIVE_NOT_ACTIVE',
      'error', 'El encuentro no está activo en modo en vivo.',
      'partido', jsonb_build_object(
        'id', v_match.id, 'estado', v_match.estado, 'en_vivo', v_match.en_vivo,
        'goles_favor', v_match.goles_favor, 'goles_contra', v_match.goles_contra,
        'live_etapa', v_match.live_etapa, 'live_updated_at', v_match.live_updated_at,
        'live_updated_by', v_match.live_updated_by
      )
    );
  end if;

  if p_expected_live_updated_at is null then
    return jsonb_build_object('success', false, 'code', 'LIVE_VERSION_REQUIRED', 'error', 'Sincroniza el encuentro antes de modificar estadísticas.');
  end if;

  if v_match.live_updated_at is distinct from p_expected_live_updated_at then
    return jsonb_build_object(
      'success', false,
      'code', 'LIVE_STATE_CONFLICT',
      'error', 'El encuentro cambió en otro dispositivo. Sincroniza antes de continuar.',
      'partido', jsonb_build_object(
        'id', v_match.id, 'estado', v_match.estado, 'en_vivo', v_match.en_vivo,
        'goles_favor', v_match.goles_favor, 'goles_contra', v_match.goles_contra,
        'live_etapa', v_match.live_etapa, 'live_updated_at', v_match.live_updated_at,
        'live_updated_by', v_match.live_updated_by
      )
    );
  end if;

  if coalesce(p_es_mvp, false) then
    update public.partido_estadisticas
    set es_mvp = false
    where partido_id = p_partido_id
      and jugador_id is distinct from p_jugador_id
      and es_mvp is true;
  end if;

  insert into public.partido_estadisticas (
    partido_id, jugador_id, asistio, disciplina_codigo, metricas_competitivas,
    metricas_version, es_mvp, goles, asistencias, tarjetas_amarillas, tarjetas_rojas
  ) values (
    p_partido_id, p_jugador_id, coalesce(p_asistio, true), p_disciplina_codigo,
    coalesce(p_metricas_competitivas, '{}'::jsonb), coalesce(p_metricas_version, 1),
    coalesce(p_es_mvp, false), coalesce(p_goles, 0), coalesce(p_asistencias, 0),
    coalesce(p_tarjetas_amarillas, 0), coalesce(p_tarjetas_rojas, 0)
  )
  on conflict (partido_id, jugador_id) do update set
    asistio = excluded.asistio,
    disciplina_codigo = excluded.disciplina_codigo,
    metricas_competitivas = excluded.metricas_competitivas,
    metricas_version = excluded.metricas_version,
    es_mvp = excluded.es_mvp,
    goles = excluded.goles,
    asistencias = excluded.asistencias,
    tarjetas_amarillas = excluded.tarjetas_amarillas,
    tarjetas_rojas = excluded.tarjetas_rojas
  returning * into v_stat;

  update public.partidos
  set live_updated_at = v_now,
      live_updated_by = p_usuario_id
  where id = p_partido_id
    and academia_id = p_academia_id;

  return jsonb_build_object(
    'success', true,
    'estadistica', to_jsonb(v_stat),
    'live_updated_at', v_now
  );
end;
$$;

revoke all on function public.registrar_estadistica_live_v2(uuid,uuid,uuid,timestamptz,boolean,text,jsonb,smallint,boolean,integer,integer,integer,integer,uuid) from public;
revoke all on function public.registrar_estadistica_live_v2(uuid,uuid,uuid,timestamptz,boolean,text,jsonb,smallint,boolean,integer,integer,integer,integer,uuid) from anon;
revoke all on function public.registrar_estadistica_live_v2(uuid,uuid,uuid,timestamptz,boolean,text,jsonb,smallint,boolean,integer,integer,integer,integer,uuid) from authenticated;
grant execute on function public.registrar_estadistica_live_v2(uuid,uuid,uuid,timestamptz,boolean,text,jsonb,smallint,boolean,integer,integer,integer,integer,uuid) to service_role;
