-- Mercado Pago OAuth tokens are stored in Supabase Vault.
-- EXECUTE is restricted to service_role, so the functions do not depend on
-- legacy request.jwt.claim.role session settings that may be absent in PostgREST.

create or replace function public.store_mercadopago_secret(
  p_secret_id uuid,
  p_secret text,
  p_name text,
  p_description text default ''::text
) returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare v_id uuid;
begin
  if p_secret is null or length(p_secret) < 8 then
    raise exception 'invalid secret';
  end if;

  if p_secret_id is null then
    select vault.create_secret(p_secret, p_name, p_description) into v_id;
  else
    perform vault.update_secret(p_secret_id, p_secret, p_name, p_description);
    v_id := p_secret_id;
  end if;

  return v_id;
end;
$$;

create or replace function public.read_mercadopago_secret(
  p_secret_id uuid
) returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare v_secret text;
begin
  select decrypted_secret
    into v_secret
  from vault.decrypted_secrets
  where id = p_secret_id;

  return v_secret;
end;
$$;

revoke all on function public.store_mercadopago_secret(uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.read_mercadopago_secret(uuid) from public, anon, authenticated;
grant execute on function public.store_mercadopago_secret(uuid,text,text,text) to service_role;
grant execute on function public.read_mercadopago_secret(uuid) to service_role;
