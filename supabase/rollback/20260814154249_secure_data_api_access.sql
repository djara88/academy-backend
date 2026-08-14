-- Emergency rollback only. This restores the legacy broad Data API access.
-- Prefer fixing a specific missing grant or policy instead of running this file.

grant select, insert, update, delete on all tables in schema public to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

do $$
declare
  table_record record;
begin
  for table_record in
    select c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
  loop
    execute format(
      'create policy %I on public.%I for all to public using (true) with check (true)',
      'legacy_access_' || table_record.table_name,
      table_record.table_name
    );
  end loop;
end
$$;
