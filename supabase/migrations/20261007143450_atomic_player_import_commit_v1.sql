CREATE OR REPLACE FUNCTION public.commit_player_import_v1(p_academia_id uuid, p_sede_id uuid, p_rama_id uuid, p_rows jsonb, p_file_name text DEFAULT NULL::text, p_created_by uuid DEFAULT NULL::uuid, p_total_rows integer DEFAULT NULL::integer, p_skipped integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path = ''
 SET statement_timeout = '90s'
AS $function$
declare
  v_lote_id uuid;
  v_row jsonb;
  v_row_number integer;
  v_rama_nombre text;
  v_disciplina text;
  v_sede_nombre text;
  v_category_name text;
  v_category_id uuid;
  v_category_created boolean;
  v_tutor_id uuid;
  v_tutor_created boolean;
  v_tutor_name text;
  v_tutor_doc_key text;
  v_tutor_email text;
  v_tutor_phone text;
  v_player_id uuid;
  v_player_created boolean;
  v_player_doc_key text;
  v_player_name text;
  v_enrollment_id uuid;
  v_link_id uuid;
  v_charge_id uuid;
  v_status text;
  v_has_active_any boolean;
  v_rows_count integer;
  v_total integer;
  v_imported integer := 0;
  v_created_players integer := 0;
  v_enrolled_existing integer := 0;
  v_saldo numeric;
  v_matricula numeric;
  v_mensualidad numeric;
  v_summary jsonb;
begin
  if p_academia_id is null or p_sede_id is null or p_rama_id is null then
    raise exception 'IMPORT_INVALID_SCOPE';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'IMPORT_ROWS_MUST_BE_ARRAY';
  end if;

  v_rows_count := jsonb_array_length(p_rows);
  v_total := coalesce(p_total_rows, v_rows_count + greatest(coalesce(p_skipped, 0), 0));

  if v_rows_count < 1 or v_rows_count > 3000 or v_total < v_rows_count or v_total > 3000 then
    raise exception 'IMPORT_ROW_LIMIT';
  end if;

  if coalesce(p_skipped, 0) < 0 then
    raise exception 'IMPORT_INVALID_SKIPPED_COUNT';
  end if;

  select r.nombre, r.disciplina, s.nombre
    into v_rama_nombre, v_disciplina, v_sede_nombre
  from public.ramas r
  join public.sedes s
    on s.id = r.sede_id
   and s.academia_id = p_academia_id
  where r.id = p_rama_id
    and r.academia_id = p_academia_id
    and r.sede_id = p_sede_id;

  if not found then
    raise exception 'IMPORT_INVALID_SCOPE';
  end if;

  -- Solo una importación por academia/rama puede confirmar a la vez.
  perform pg_advisory_xact_lock(
    hashtextextended(p_academia_id::text || ':' || p_rama_id::text, 91357)
  );

  -- Defensa en profundidad: el backend ya lo valida, pero la transacción no confía en el payload.
  if exists (
    select 1
    from (
      select
        regexp_replace(
          upper(btrim(coalesce(item->>'rut_alumno', ''))),
          '[^A-Z0-9]',
          '',
          'g'
        ) as document_key,
        count(*) as occurrences
      from jsonb_array_elements(p_rows) item
      where regexp_replace(
        upper(btrim(coalesce(item->>'rut_alumno', ''))),
        '[^A-Z0-9]',
        '',
        'g'
      ) <> ''
      group by 1
      having count(*) > 1
    ) duplicated
  ) then
    raise exception 'IMPORT_DUPLICATE_PLAYER_DOCUMENT';
  end if;

  insert into public.import_lotes (
    academia_id,
    sede_id,
    rama_id,
    nombre_archivo,
    estado,
    total_filas,
    created_by,
    resumen
  )
  values (
    p_academia_id,
    p_sede_id,
    p_rama_id,
    nullif(btrim(coalesce(p_file_name, '')), ''),
    'procesando',
    v_total,
    p_created_by,
    jsonb_build_object(
      'rama', v_rama_nombre,
      'disciplina', v_disciplina,
      'sede', v_sede_nombre,
      'atomic', true
    )
  )
  returning id into v_lote_id;

  for v_row in
    select value
    from jsonb_array_elements(p_rows)
  loop
    v_row_number := coalesce(nullif(v_row->>'fila', '')::integer, v_imported + 2);
    v_player_name := btrim(coalesce(v_row->>'nombre_alumno', ''));
    if v_player_name = '' then
      raise exception 'IMPORT_PLAYER_NAME_REQUIRED fila=%', v_row_number;
    end if;

    v_category_name := btrim(coalesce(v_row->>'categoria', ''));
    v_category_id := null;
    v_category_created := false;

    if v_category_name <> '' then
      select c.id
        into v_category_id
      from public.categorias c
      where c.academia_id = p_academia_id
        and c.rama_id = p_rama_id
        and lower(btrim(c.nombre::text)) = lower(v_category_name)
      limit 1;

      if v_category_id is null then
        begin
          insert into public.categorias (
            academia_id, sede_id, rama_id, nombre
          )
          values (
            p_academia_id, p_sede_id, p_rama_id, v_category_name
          )
          returning id into v_category_id;
          v_category_created := true;
        exception
          when unique_violation then
            select c.id
              into v_category_id
            from public.categorias c
            where c.academia_id = p_academia_id
              and c.rama_id = p_rama_id
              and lower(btrim(c.nombre::text)) = lower(v_category_name)
            limit 1;
            if v_category_id is null then
              raise;
            end if;
        end;
      end if;

      if v_category_created then
        insert into public.import_lote_items (
          lote_id, academia_id, fila, entidad, entidad_id, accion, detalle
        )
        values (
          v_lote_id, p_academia_id, v_row_number, 'categoria', v_category_id, 'creado',
          jsonb_build_object('nombre', v_category_name, 'rama_id', p_rama_id, 'sede_id', p_sede_id)
        );
      end if;
    end if;

    v_player_id := null;
    v_player_created := false;
    v_player_doc_key := regexp_replace(
      upper(btrim(coalesce(v_row->>'rut_alumno', ''))),
      '[^A-Z0-9]',
      '',
      'g'
    );

    if nullif(v_row->>'jugador_existente_id', '') is not null then
      select j.id
        into v_player_id
      from public.jugadores j
      where j.id = (v_row->>'jugador_existente_id')::uuid
        and j.academia_id = p_academia_id
      limit 1;

      if v_player_id is null then
        raise exception 'IMPORT_PLAYER_SCOPE_MISMATCH fila=%', v_row_number;
      end if;
    elsif v_player_doc_key <> '' then
      select j.id
        into v_player_id
      from public.jugadores j
      where j.academia_id = p_academia_id
        and v_player_doc_key = any(array[
          regexp_replace(upper(btrim(coalesce(j.rut, ''))), '[^A-Z0-9]', '', 'g'),
          regexp_replace(upper(btrim(coalesce(j.numero_documento, ''))), '[^A-Z0-9]', '', 'g'),
          regexp_replace(upper(btrim(coalesce(j.dni, ''))), '[^A-Z0-9]', '', 'g'),
          regexp_replace(upper(btrim(coalesce(j.pasaporte, ''))), '[^A-Z0-9]', '', 'g'),
          regexp_replace(upper(btrim(coalesce(j.rut_pasaporte, ''))), '[^A-Z0-9]', '', 'g')
        ])
      order by j.created_at asc
      limit 1;
    end if;

    if v_player_id is not null and exists (
      select 1
      from public.inscripciones_deportivas i
      where i.academia_id = p_academia_id
        and i.jugador_id = v_player_id
        and i.rama_id = p_rama_id
        and i.estado = 'Activa'
    ) then
      raise exception 'IMPORT_ACTIVE_ENROLLMENT_EXISTS fila=%', v_row_number;
    end if;

    if v_player_id is null then
      v_tutor_id := null;
      v_tutor_created := false;
      v_tutor_name := btrim(coalesce(v_row->>'nombre_apoderado', ''));
      v_tutor_doc_key := regexp_replace(
        upper(btrim(coalesce(v_row->>'rut_apoderado', ''))),
        '[^A-Z0-9]',
        '',
        'g'
      );
      v_tutor_email := lower(btrim(coalesce(v_row->>'email_apoderado', '')));
      v_tutor_phone := btrim(coalesce(v_row->>'telefono_apoderado', ''));

      if v_tutor_name <> '' then
        select t.id
          into v_tutor_id
        from public.tutores t
        where t.academia_id = p_academia_id
          and (
            (v_tutor_doc_key <> '' and regexp_replace(upper(btrim(coalesce(t.rut, ''))), '[^A-Z0-9]', '', 'g') = v_tutor_doc_key)
            or (v_tutor_email <> '' and lower(btrim(coalesce(t.email, ''))) = v_tutor_email)
            or (
              lower(btrim(coalesce(t.nombre_completo, t.nombre, ''))) = lower(v_tutor_name)
              and btrim(coalesce(t.telefono, '')) = v_tutor_phone
            )
          )
        order by t.created_at asc
        limit 1;

        if v_tutor_id is null then
          insert into public.tutores (
            academia_id, nombre_completo, rut, telefono, email
          )
          values (
            p_academia_id,
            v_tutor_name,
            nullif(btrim(coalesce(v_row->>'rut_apoderado', '')), ''),
            nullif(v_tutor_phone, ''),
            nullif(v_tutor_email, '')
          )
          returning id into v_tutor_id;
          v_tutor_created := true;

          insert into public.import_lote_items (
            lote_id, academia_id, fila, entidad, entidad_id, accion, detalle
          )
          values (
            v_lote_id, p_academia_id, v_row_number, 'tutor', v_tutor_id, 'creado',
            jsonb_build_object('nombre', v_tutor_name)
          );
        end if;
      end if;

      v_matricula := greatest(coalesce(nullif(v_row->>'monto_matricula', '')::numeric, 0), 0);
      v_mensualidad := greatest(coalesce(nullif(v_row->>'mensualidad', '')::numeric, 0), 0);
      v_saldo := greatest(coalesce(nullif(v_row->>'saldo_pendiente', '')::numeric, 0), 0);

      insert into public.jugadores (
        academia_id,
        sede_id,
        rama_id,
        tutor_id,
        categoria_id,
        nombre,
        rut,
        fecha_nacimiento,
        sexo,
        posicion_cancha,
        tipo_alumno,
        estado,
        estado_matricula,
        monto_matricula,
        monto_mensualidad,
        talla_uniforme,
        numero_camiseta,
        saldo_pendiente,
        estado_financiero
      )
      values (
        p_academia_id,
        p_sede_id,
        p_rama_id,
        v_tutor_id,
        v_category_id,
        v_player_name,
        nullif(btrim(coalesce(v_row->>'rut_alumno', '')), ''),
        nullif(v_row->>'fecha_nacimiento', '')::date,
        nullif(btrim(coalesce(v_row->>'sexo', '')), ''),
        nullif(btrim(coalesce(v_row->>'posicion', '')), ''),
        'Antiguo',
        coalesce(nullif(btrim(v_row->>'estado'), ''), 'Activo'),
        'Migrado',
        v_matricula,
        v_mensualidad,
        nullif(btrim(coalesce(v_row->>'talla_uniforme', '')), ''),
        nullif(v_row->>'numero_camiseta', '')::integer,
        v_saldo,
        case when v_saldo > 0 then 'Moroso' else 'Al Día' end
      )
      returning id into v_player_id;

      v_player_created := true;
      v_created_players := v_created_players + 1;

      insert into public.import_lote_items (
        lote_id, academia_id, fila, entidad, entidad_id, accion, detalle
      )
      values (
        v_lote_id, p_academia_id, v_row_number, 'jugador', v_player_id, 'creado',
        jsonb_build_object('nombre', v_player_name, 'rama_id', p_rama_id, 'sede_id', p_sede_id)
      );
    else
      v_matricula := greatest(coalesce(nullif(v_row->>'monto_matricula', '')::numeric, 0), 0);
      v_mensualidad := greatest(coalesce(nullif(v_row->>'mensualidad', '')::numeric, 0), 0);
      v_saldo := greatest(coalesce(nullif(v_row->>'saldo_pendiente', '')::numeric, 0), 0);
      v_enrolled_existing := v_enrolled_existing + 1;
    end if;

    v_status := case
      when lower(coalesce(v_row->>'estado', '')) like '%retir%' then 'Retirada'
      when lower(coalesce(v_row->>'estado', '')) like '%inactiv%' then 'Inactiva'
      else 'Activa'
    end;

    select exists (
      select 1
      from public.inscripciones_deportivas i
      where i.academia_id = p_academia_id
        and i.jugador_id = v_player_id
        and i.estado = 'Activa'
    )
    into v_has_active_any;

    insert into public.inscripciones_deportivas (
      academia_id,
      jugador_id,
      sede_id,
      rama_id,
      categoria_id,
      estado,
      fecha_inicio,
      monto_matricula,
      monto_mensualidad,
      es_principal,
      rol_especialidad
    )
    values (
      p_academia_id,
      v_player_id,
      p_sede_id,
      p_rama_id,
      v_category_id,
      v_status,
      current_date,
      v_matricula,
      v_mensualidad,
      v_player_created or not v_has_active_any,
      nullif(btrim(coalesce(v_row->>'posicion', '')), '')
    )
    returning id into v_enrollment_id;

    insert into public.import_lote_items (
      lote_id, academia_id, fila, entidad, entidad_id, accion, detalle
    )
    values (
      v_lote_id, p_academia_id, v_row_number, 'inscripcion', v_enrollment_id, 'creado',
      jsonb_build_object(
        'jugador_id', v_player_id,
        'rama_id', p_rama_id,
        'sede_id', p_sede_id,
        'categoria_id', v_category_id,
        'estado', v_status,
        'alumno_existente', not v_player_created
      )
    );

    if v_category_id is not null then
      v_link_id := null;
      insert into public.jugador_categoria (jugador_id, categoria_id)
      values (v_player_id, v_category_id)
      on conflict (jugador_id, categoria_id) do nothing
      returning id into v_link_id;

      if v_link_id is not null then
        insert into public.import_lote_items (
          lote_id, academia_id, fila, entidad, entidad_id, accion, detalle
        )
        values (
          v_lote_id, p_academia_id, v_row_number, 'jugador_categoria', v_link_id, 'creado',
          jsonb_build_object('jugador_id', v_player_id, 'categoria_id', v_category_id)
        );
      end if;
    end if;

    if v_saldo > 0 then
      insert into public.cobros (
        academia_id,
        jugador_id,
        inscripcion_id,
        sede_id,
        rama_id,
        concepto,
        tipo_concepto,
        monto,
        monto_pagado,
        estado,
        fecha_vencimiento,
        observaciones
      )
      values (
        p_academia_id,
        v_player_id,
        v_enrollment_id,
        p_sede_id,
        p_rama_id,
        'Saldo inicial migrado',
        'Migración',
        v_saldo,
        0,
        'Pendiente',
        current_date,
        format('Importado en %s', v_rama_nombre)
      )
      returning id into v_charge_id;

      insert into public.import_lote_items (
        lote_id, academia_id, fila, entidad, entidad_id, accion, detalle
      )
      values (
        v_lote_id, p_academia_id, v_row_number, 'cobro', v_charge_id, 'creado',
        jsonb_build_object(
          'concepto', 'Saldo inicial migrado',
          'inscripcion_id', v_enrollment_id,
          'rama_id', p_rama_id
        )
      );
    end if;

    v_imported := v_imported + 1;
  end loop;

  v_summary := jsonb_build_object(
    'total', v_total,
    'imported', v_imported,
    'created_players', v_created_players,
    'enrolled_existing', v_enrolled_existing,
    'skipped', greatest(coalesce(p_skipped, 0), 0),
    'failed', 0,
    'rama_id', p_rama_id,
    'rama', v_rama_nombre,
    'disciplina', v_disciplina,
    'sede_id', p_sede_id,
    'sede', v_sede_nombre,
    'atomic', true
  );

  update public.import_lotes
  set estado = 'completado',
      filas_importadas = v_imported,
      filas_omitidas = greatest(coalesce(p_skipped, 0), 0),
      filas_error = 0,
      resumen = v_summary,
      completed_at = now()
  where id = v_lote_id
    and academia_id = p_academia_id;

  return jsonb_build_object(
    'lote_id', v_lote_id,
    'estado', 'completado',
    'scope', jsonb_build_object(
      'rama_id', p_rama_id,
      'rama_nombre', v_rama_nombre,
      'disciplina', v_disciplina,
      'sede_id', p_sede_id,
      'sede_nombre', v_sede_nombre
    ),
    'summary', jsonb_build_object(
      'total', v_total,
      'imported', v_imported,
      'created_players', v_created_players,
      'enrolled_existing', v_enrolled_existing,
      'skipped', greatest(coalesce(p_skipped, 0), 0),
      'failed', 0
    ),
    'errors', '[]'::jsonb
  );
end;
$function$

revoke execute on function public.commit_player_import_v1(uuid, uuid, uuid, jsonb, text, uuid, integer, integer) from public;
revoke execute on function public.commit_player_import_v1(uuid, uuid, uuid, jsonb, text, uuid, integer, integer) from anon;
revoke execute on function public.commit_player_import_v1(uuid, uuid, uuid, jsonb, text, uuid, integer, integer) from authenticated;
grant execute on function public.commit_player_import_v1(uuid, uuid, uuid, jsonb, text, uuid, integer, integer) to service_role;

comment on function public.commit_player_import_v1(uuid, uuid, uuid, jsonb, text, uuid, integer, integer)
is 'Commits a validated player import as one PostgreSQL transaction. Any unhandled error rolls back the entire batch.';
