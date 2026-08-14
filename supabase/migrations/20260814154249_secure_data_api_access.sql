-- The backend uses service_role. Browser clients only need to read their own
-- user record and academy during authentication/bootstrap.

do $$
declare
  table_record record;
  policy_record record;
begin
  for table_record in
    select c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
  loop
    execute format('alter table public.%I enable row level security', table_record.table_name);
  end loop;

  for policy_record in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      policy_record.policyname,
      policy_record.schemaname,
      policy_record.tablename
    );
  end loop;
end
$$;

revoke all privileges on all tables in schema public from anon, authenticated;
revoke all privileges on all sequences in schema public from anon, authenticated;

grant usage on schema public to authenticated;
grant select on table public.usuarios, public.academias to authenticated;

create policy usuarios_lectura_propia
on public.usuarios
for select
to authenticated
using (id = (select auth.uid()));

create policy academias_lectura_propia
on public.academias
for select
to authenticated
using (
  id in (
    select usuario.academia_id
    from public.usuarios as usuario
    where usuario.id = (select auth.uid())
  )
);

-- Future objects must not silently become writable through the Data API.
alter default privileges in schema public
  revoke all privileges on tables from anon, authenticated;
alter default privileges in schema public
  revoke all privileges on sequences from anon, authenticated;
alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;
