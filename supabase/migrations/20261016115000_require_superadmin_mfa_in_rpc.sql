-- Fase 5: enforce verified MFA at the database RPC boundary, not only in the UI/API.
-- Only the configured superadmin and Supabase-verified JWTs with aal2 may read this result.
-- Supabase SECURITY DEFINER still uses search_path='' and row access remains unchanged.
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
  if v_uid is distinct from '41927ee7-9dfc-4810-8a6d-7751346a155b'::uuid
     or coalesce(auth.jwt()->>'aal', 'aal1') <> 'aal2' then
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
