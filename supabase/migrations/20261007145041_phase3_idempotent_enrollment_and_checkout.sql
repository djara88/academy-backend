alter table public.inscripciones_deportivas
  add column if not exists idempotency_key text;

create unique index if not exists inscripciones_deportivas_idempotency_key_uq
  on public.inscripciones_deportivas (academia_id, idempotency_key)
  where idempotency_key is not null;

comment on column public.inscripciones_deportivas.idempotency_key
is 'Client/server operation key used to make enrollment creation safe to retry.';

CREATE OR REPLACE FUNCTION public.create_sport_enrollment_v2(p_academia_id uuid, p_usuario_id uuid, p_jugador_id uuid, p_sede_id uuid, p_rama_id uuid, p_categoria_id uuid DEFAULT NULL::uuid, p_monto_matricula numeric DEFAULT 0, p_abono_matricula numeric DEFAULT 0, p_monto_mensualidad numeric DEFAULT 0, p_idempotency_key text DEFAULT NULL::text, p_solicitud_id uuid DEFAULT NULL::uuid, p_respuesta text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path = ''
AS $function$
declare
  v_key text := nullif(left(btrim(coalesce(p_idempotency_key, '')), 160), '');
  v_request public.solicitudes_inscripcion_deportiva%rowtype;
  v_player public.jugadores%rowtype;
  v_site public.sedes%rowtype;
  v_branch public.ramas%rowtype;
  v_category public.categorias%rowtype;
  v_enrollment public.inscripciones_deportivas%rowtype;
  v_charge public.cobros%rowtype;
  v_matricula numeric := greatest(coalesce(p_monto_matricula, 0), 0);
  v_mensualidad numeric := greatest(coalesce(p_monto_mensualidad, 0), 0);
  v_abono numeric;
  v_active_count integer := 0;
  v_charge_ids uuid[] := array[]::uuid[];
  v_today date := (timezone('America/Santiago', now()))::date;
  v_period date := date_trunc('month', timezone('America/Santiago', now()))::date;
begin
  if p_academia_id is null or p_jugador_id is null or p_sede_id is null or p_rama_id is null then
    raise exception 'SPORT_ENROLLMENT_INVALID_SCOPE';
  end if;

  v_abono := least(greatest(coalesce(p_abono_matricula, 0), 0), v_matricula);

  perform pg_advisory_xact_lock(
    hashtextextended(
      p_academia_id::text || ':' || p_jugador_id::text || ':' || p_rama_id::text,
      38117
    )
  );

  if p_solicitud_id is not null then
    select * into v_request
    from public.solicitudes_inscripcion_deportiva
    where id = p_solicitud_id
      and academia_id = p_academia_id
    for update;

    if not found then
      raise exception 'SPORT_REQUEST_NOT_FOUND';
    end if;

    if v_request.jugador_id <> p_jugador_id
       or v_request.sede_id <> p_sede_id
       or v_request.rama_id <> p_rama_id then
      raise exception 'SPORT_REQUEST_SCOPE_MISMATCH';
    end if;

    if v_request.estado = 'aprobada' and v_request.inscripcion_id is not null then
      select * into v_enrollment
      from public.inscripciones_deportivas
      where id = v_request.inscripcion_id
        and academia_id = p_academia_id;

      if found then
        select coalesce(array_agg(id order by created_at), array[]::uuid[])
          into v_charge_ids
        from public.cobros
        where academia_id = p_academia_id
          and inscripcion_id = v_enrollment.id
          and estado <> 'Anulado';

        return jsonb_build_object(
          'enrollment', to_jsonb(v_enrollment),
          'charge_ids', to_jsonb(v_charge_ids),
          'idempotent', true,
          'request_id', p_solicitud_id
        );
      end if;
    end if;

    if v_request.estado <> 'pendiente' then
      raise exception 'SPORT_REQUEST_RESOLVED';
    end if;
  end if;

  if v_key is not null then
    select * into v_enrollment
    from public.inscripciones_deportivas
    where academia_id = p_academia_id
      and idempotency_key = v_key
    limit 1;

    if found then
      if v_enrollment.jugador_id <> p_jugador_id
         or v_enrollment.sede_id <> p_sede_id
         or v_enrollment.rama_id <> p_rama_id
         or coalesce(v_enrollment.categoria_id::text, '') <> coalesce(p_categoria_id::text, '')
         or coalesce(v_enrollment.monto_matricula, 0) <> v_matricula
         or coalesce(v_enrollment.monto_mensualidad, 0) <> v_mensualidad then
        raise exception 'IDEMPOTENCY_KEY_REUSED';
      end if;

      select coalesce(array_agg(id order by created_at), array[]::uuid[])
        into v_charge_ids
      from public.cobros
      where academia_id = p_academia_id
        and inscripcion_id = v_enrollment.id
        and estado <> 'Anulado';

      if p_solicitud_id is not null and v_request.estado = 'pendiente' then
        update public.solicitudes_inscripcion_deportiva
        set estado = 'aprobada',
            monto_matricula = v_matricula,
            abono_matricula = v_abono,
            monto_mensualidad = v_mensualidad,
            categoria_id = p_categoria_id,
            inscripcion_id = v_enrollment.id,
            resuelto_por = p_usuario_id,
            respuesta = coalesce(nullif(btrim(p_respuesta), ''), 'Solicitud aprobada por la academia.'),
            resuelto_at = now(),
            updated_at = now()
        where id = p_solicitud_id
          and academia_id = p_academia_id
          and estado = 'pendiente';
      end if;

      return jsonb_build_object(
        'enrollment', to_jsonb(v_enrollment),
        'charge_ids', to_jsonb(v_charge_ids),
        'idempotent', true,
        'request_id', p_solicitud_id
      );
    end if;
  end if;

  select * into v_player
  from public.jugadores
  where id = p_jugador_id
    and academia_id = p_academia_id;
  if not found then raise exception 'SPORT_PLAYER_NOT_FOUND'; end if;

  select * into v_site
  from public.sedes
  where id = p_sede_id
    and academia_id = p_academia_id
    and activa = true;
  if not found then raise exception 'SPORT_SITE_NOT_AVAILABLE'; end if;

  select * into v_branch
  from public.ramas
  where id = p_rama_id
    and academia_id = p_academia_id
    and sede_id = p_sede_id
    and activa = true;
  if not found then raise exception 'SPORT_BRANCH_NOT_AVAILABLE'; end if;

  if p_categoria_id is not null then
    select * into v_category
    from public.categorias
    where id = p_categoria_id
      and academia_id = p_academia_id
      and sede_id = p_sede_id
      and rama_id = p_rama_id;
    if not found then raise exception 'SPORT_CATEGORY_SCOPE_MISMATCH'; end if;
  end if;

  select * into v_enrollment
  from public.inscripciones_deportivas
  where academia_id = p_academia_id
    and jugador_id = p_jugador_id
    and rama_id = p_rama_id
    and estado = 'Activa'
  limit 1
  for update;

  if found then
    if p_solicitud_id is not null then
      update public.solicitudes_inscripcion_deportiva
      set estado = 'aprobada',
          monto_matricula = coalesce(v_enrollment.monto_matricula, 0),
          abono_matricula = least(v_abono, coalesce(v_enrollment.monto_matricula, 0)),
          monto_mensualidad = coalesce(v_enrollment.monto_mensualidad, 0),
          categoria_id = v_enrollment.categoria_id,
          inscripcion_id = v_enrollment.id,
          resuelto_por = p_usuario_id,
          respuesta = coalesce(nullif(btrim(p_respuesta), ''), 'Solicitud aprobada por la academia.'),
          resuelto_at = now(),
          updated_at = now()
      where id = p_solicitud_id
        and academia_id = p_academia_id
        and estado = 'pendiente';

      select coalesce(array_agg(id order by created_at), array[]::uuid[])
        into v_charge_ids
      from public.cobros
      where academia_id = p_academia_id
        and inscripcion_id = v_enrollment.id
        and estado <> 'Anulado';

      return jsonb_build_object(
        'enrollment', to_jsonb(v_enrollment),
        'charge_ids', to_jsonb(v_charge_ids),
        'idempotent', true,
        'request_id', p_solicitud_id
      );
    end if;

    if coalesce(v_enrollment.categoria_id::text, '') = coalesce(p_categoria_id::text, '')
       and coalesce(v_enrollment.monto_matricula, 0) = v_matricula
       and coalesce(v_enrollment.monto_mensualidad, 0) = v_mensualidad then
      select coalesce(array_agg(id order by created_at), array[]::uuid[])
        into v_charge_ids
      from public.cobros
      where academia_id = p_academia_id
        and inscripcion_id = v_enrollment.id
        and estado <> 'Anulado';

      return jsonb_build_object(
        'enrollment', to_jsonb(v_enrollment),
        'charge_ids', to_jsonb(v_charge_ids),
        'idempotent', true,
        'request_id', null
      );
    end if;

    raise exception 'SPORT_ENROLLMENT_EXISTS';
  end if;

  select count(*)::integer into v_active_count
  from public.inscripciones_deportivas
  where academia_id = p_academia_id
    and jugador_id = p_jugador_id
    and estado = 'Activa';

  insert into public.inscripciones_deportivas (
    academia_id, jugador_id, sede_id, rama_id, categoria_id,
    estado, fecha_inicio, monto_matricula, monto_mensualidad,
    es_principal, idempotency_key
  )
  values (
    p_academia_id, p_jugador_id, p_sede_id, p_rama_id, p_categoria_id,
    'Activa', v_today, v_matricula, v_mensualidad,
    v_active_count = 0, v_key
  )
  returning * into v_enrollment;

  if p_categoria_id is not null then
    insert into public.jugador_categoria (jugador_id, categoria_id)
    values (p_jugador_id, p_categoria_id)
    on conflict (jugador_id, categoria_id) do nothing;
  end if;

  if v_matricula > 0 then
    insert into public.cobros (
      academia_id, inscripcion_id, sede_id, rama_id, jugador_id,
      concepto, tipo_concepto, monto, monto_pagado, estado,
      fecha_vencimiento, idempotency_key
    )
    values (
      p_academia_id, v_enrollment.id, p_sede_id, p_rama_id, p_jugador_id,
      'Matrícula ' || coalesce(nullif(v_branch.disciplina, ''), v_branch.nombre)
        || case when p_categoria_id is not null then ' · ' || v_category.nombre else '' end,
      'Matrícula', v_matricula, 0, 'Pendiente',
      v_today, 'sport-enrollment:' || v_enrollment.id::text || ':matricula'
    )
    returning * into v_charge;
    v_charge_ids := array_append(v_charge_ids, v_charge.id);

    if v_abono > 0 then
      perform public.registrar_pago_cobro(
        p_academia_id,
        v_charge.id,
        v_abono,
        'Sin registrar',
        'Abono al inscribir en ' || coalesce(nullif(v_branch.disciplina, ''), v_branch.nombre),
        'sport-enrollment:' || v_enrollment.id::text || ':abono',
        p_usuario_id
      );
    end if;
  end if;

  if v_mensualidad > 0 then
    insert into public.cobros (
      academia_id, inscripcion_id, sede_id, rama_id, jugador_id,
      concepto, tipo_concepto, monto, monto_pagado, estado,
      fecha_vencimiento, periodo_mensualidad, idempotency_key
    )
    values (
      p_academia_id, v_enrollment.id, p_sede_id, p_rama_id, p_jugador_id,
      'Mensualidad Inicial · ' || coalesce(nullif(v_branch.disciplina, ''), v_branch.nombre),
      'Mensualidad', v_mensualidad, 0, 'Pendiente',
      v_today, v_period,
      'sport-enrollment:' || v_enrollment.id::text || ':mensualidad:' || to_char(v_period, 'YYYY-MM')
    )
    returning * into v_charge;
    v_charge_ids := array_append(v_charge_ids, v_charge.id);
  end if;

  if p_solicitud_id is not null then
    update public.solicitudes_inscripcion_deportiva
    set estado = 'aprobada',
        monto_matricula = v_matricula,
        abono_matricula = v_abono,
        monto_mensualidad = v_mensualidad,
        categoria_id = p_categoria_id,
        inscripcion_id = v_enrollment.id,
        resuelto_por = p_usuario_id,
        respuesta = coalesce(nullif(btrim(p_respuesta), ''), 'Solicitud aprobada por la academia.'),
        resuelto_at = now(),
        updated_at = now()
    where id = p_solicitud_id
      and academia_id = p_academia_id
      and estado = 'pendiente';

    if not found then
      raise exception 'SPORT_REQUEST_RESOLVED';
    end if;
  end if;

  return jsonb_build_object(
    'enrollment', to_jsonb(v_enrollment),
    'charge_ids', to_jsonb(v_charge_ids),
    'idempotent', false,
    'request_id', p_solicitud_id
  );
end;
$function$

revoke execute on function public.create_sport_enrollment_v2(uuid,uuid,uuid,uuid,uuid,uuid,numeric,numeric,numeric,text,uuid,text) from public;
revoke execute on function public.create_sport_enrollment_v2(uuid,uuid,uuid,uuid,uuid,uuid,numeric,numeric,numeric,text,uuid,text) from anon;
revoke execute on function public.create_sport_enrollment_v2(uuid,uuid,uuid,uuid,uuid,uuid,numeric,numeric,numeric,text,uuid,text) from authenticated;
grant execute on function public.create_sport_enrollment_v2(uuid,uuid,uuid,uuid,uuid,uuid,numeric,numeric,numeric,text,uuid,text) to service_role;

alter table public.plataforma_cobros
  add column if not exists idempotency_key text,
  add column if not exists idempotency_fingerprint text;

create unique index if not exists plataforma_cobros_active_idempotency_uq
  on public.plataforma_cobros (academia_id, idempotency_key)
  where idempotency_key is not null
    and estado in ('pendiente','vencido','pagado');

create unique index if not exists plataforma_cobros_one_open_initial_per_academy
  on public.plataforma_cobros (academia_id)
  where charge_kind = 'initial'
    and estado in ('pendiente','vencido');

create unique index if not exists plataforma_cobros_one_open_addon_per_academy
  on public.plataforma_cobros (academia_id)
  where charge_kind = 'addon'
    and estado in ('pendiente','vencido');

create unique index if not exists payment_gateway_orders_one_active_platform_per_charge
  on public.payment_gateway_orders (plataforma_cobro_id)
  where scope = 'plataforma'
    and plataforma_cobro_id is not null
    and status in ('created','pending');

comment on column public.plataforma_cobros.idempotency_key
is 'Client operation key for safely retrying checkout creation.';
comment on column public.plataforma_cobros.idempotency_fingerprint
is 'SHA-256 fingerprint of the immutable checkout request associated with the idempotency key.';
