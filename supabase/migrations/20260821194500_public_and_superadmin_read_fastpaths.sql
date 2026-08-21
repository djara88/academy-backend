-- Fast paths de lectura para evitar que pantallas sensibles a latencia dependan del cold start de Render.
-- No concede escrituras ni expone service_role.

create or replace function public.get_public_academy_catalog(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with academy as (
    select a.*
    from public.academias a
    where lower(a.subdominio::text) = lower(trim(p_slug))
      and a.pagina_publica_activa is true
      and lower(coalesce(a.estado::text, '')) <> 'inactiva'
    limit 1
  )
  select case when not exists (select 1 from academy) then null else jsonb_build_object(
    'academia', (
      select jsonb_build_object(
        'nombre', a.nombre,
        'slug', a.subdominio,
        'descripcion', a.descripcion_publica,
        'logo', coalesce(a.logo_url, a.logo),
        'direccion', a.direccion,
        'ciudad', a.ciudad,
        'telefono', a.telefono,
        'correo', a.correo_academia,
        'colores', jsonb_build_object(
          'primario', coalesce(a.pagina_color_primario, '#289E9D'),
          'secundario', coalesce(a.pagina_color_secundario, '#70E4DF'),
          'fondo', coalesce(a.pagina_color_fondo, '#0D1117')
        ),
        'rrss', coalesce(a.pagina_rrss, '{}'::jsonb)
      ) from academy a
    ),
    'fotos', coalesce((
      select jsonb_agg(jsonb_build_object('id', f.id, 'url', f.url, 'alt_text', f.alt_text, 'orden', f.orden) order by f.orden, f.created_at)
      from public.academia_pagina_fotos f join academy a on a.id = f.academia_id
    ), '[]'::jsonb),
    'sedes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'nombre', s.nombre, 'direccion', s.direccion, 'ciudad', s.ciudad,
        'comuna', s.comuna, 'ubicacion_entrenamiento', s.ubicacion_entrenamiento,
        'dias_entrenamiento', s.dias_entrenamiento, 'horarios_entrenamiento', s.horarios_entrenamiento
      ) order by s.principal desc, s.nombre)
      from public.sedes s join academy a on a.id = s.academia_id
      where s.activa is true
    ), '[]'::jsonb),
    'ramas', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'nombre', r.nombre, 'disciplina', r.disciplina, 'sede_id', r.sede_id) order by r.nombre)
      from public.ramas r join academy a on a.id = r.academia_id
      where r.activa is true
    ), '[]'::jsonb),
    'categorias', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'nombre', c.nombre, 'rama_id', c.rama_id, 'sede_id', c.sede_id) order by c.nombre)
      from public.categorias c
      join academy a on a.id = c.academia_id
      where exists (
        select 1 from public.ramas r
        where r.id = c.rama_id and r.academia_id = a.id and r.activa is true
      )
    ), '[]'::jsonb)
  ) end;
$$;

revoke all on function public.get_public_academy_catalog(text) from public;
grant execute on function public.get_public_academy_catalog(text) to anon, authenticated;

create or replace function public.get_saas_academies_admin()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_result jsonb;
begin
  if v_uid is distinct from '41927ee7-9dfc-4810-8a6d-7751346a155b'::uuid then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id,
    'nombre', a.nombre,
    'logo', coalesce(a.logo_url, a.logo),
    'direccion', a.direccion,
    'telefono', a.telefono,
    'correo_academia', a.correo_academia,
    'nombre_director', a.nombre_director,
    'director_email', a.director_email,
    'plan', a.plan,
    'plan_codigo', a.plan_codigo,
    'licencia_apoderados', a.licencia_apoderados,
    'estado', a.estado,
    'jugadores_count', a.jugadores_count,
    'created_at', a.created_at,
    'subscription_status', a.subscription_status,
    'trial_ends_at', a.trial_ends_at,
    'plan_price_clp', a.plan_price_clp,
    'guardian_price_clp', a.guardian_price_clp
  ) order by a.created_at desc), '[]'::jsonb)
  into v_result
  from public.academias a;

  return v_result;
end;
$$;

revoke all on function public.get_saas_academies_admin() from public;
grant execute on function public.get_saas_academies_admin() to authenticated;
