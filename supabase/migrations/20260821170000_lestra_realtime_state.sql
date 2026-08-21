-- Lestra global realtime synchronization layer.
-- Emits only academy + table scope + monotonically increasing revision.
-- No personal/business row payload is exposed through Realtime.

create table if not exists public.lestra_realtime_state (
  academia_id uuid not null references public.academias(id) on delete cascade,
  scope text not null,
  revision bigint not null default 1,
  changed_at timestamptz not null default now(),
  primary key (academia_id, scope)
);

alter table public.lestra_realtime_state enable row level security;

revoke all on table public.lestra_realtime_state from public, anon, authenticated;
grant select on table public.lestra_realtime_state to authenticated;

DROP POLICY IF EXISTS "lestra_realtime_own_academy" ON public.lestra_realtime_state;
create policy "lestra_realtime_own_academy"
on public.lestra_realtime_state
for select
to authenticated
using (
  exists (
    select 1
    from public.usuarios u
    where u.id = auth.uid()
      and u.academia_id = lestra_realtime_state.academia_id
      and coalesce(u.activo, true) = true
  )
);

create or replace function public.lestra_realtime_resolve_academia(
  p_table text,
  p_row jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_academia uuid;
  v_id uuid;
begin
  if nullif(p_row ->> 'academia_id', '') is not null then
    return (p_row ->> 'academia_id')::uuid;
  end if;

  case p_table
    when 'academias' then
      return nullif(p_row ->> 'id', '')::uuid;

    when 'asistencias' then
      v_id := nullif(p_row ->> 'entrenamiento_id', '')::uuid;
      if v_id is not null then
        select e.academia_id into v_academia from public.entrenamientos e where e.id = v_id;
      end if;
      if v_academia is null then
        v_id := nullif(p_row ->> 'jugador_id', '')::uuid;
        select j.academia_id into v_academia from public.jugadores j where j.id = v_id;
      end if;

    when 'jugador_categoria', 'jugador_insignias', 'jugador_tutor' then
      v_id := nullif(p_row ->> 'jugador_id', '')::uuid;
      select j.academia_id into v_academia from public.jugadores j where j.id = v_id;

    when 'partido_citaciones', 'partido_estadisticas' then
      v_id := nullif(p_row ->> 'partido_id', '')::uuid;
      select p.academia_id into v_academia from public.partidos p where p.id = v_id;

    when 'partido_plan_jugadores' then
      v_id := nullif(p_row ->> 'preparacion_id', '')::uuid;
      select pp.academia_id into v_academia from public.partido_preparaciones pp where pp.id = v_id;

    when 'payment_gateway_order_items' then
      v_id := nullif(p_row ->> 'order_id', '')::uuid;
      select o.academia_id into v_academia from public.payment_gateway_orders o where o.id = v_id;

    when 'whatsapp_group_members' then
      v_id := nullif(p_row ->> 'group_id', '')::uuid;
      select g.academia_id into v_academia from public.whatsapp_groups g where g.id = v_id;

    else
      v_academia := null;
  end case;

  return v_academia;
exception
  when invalid_text_representation then
    return null;
end;
$$;

revoke all on function public.lestra_realtime_resolve_academia(text, jsonb) from public, anon, authenticated;
grant execute on function public.lestra_realtime_resolve_academia(text, jsonb) to service_role;

create or replace function public.lestra_realtime_bump()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row jsonb;
  v_academia uuid;
begin
  if tg_op = 'DELETE' then
    v_row := to_jsonb(old);
  else
    v_row := to_jsonb(new);
  end if;

  v_academia := public.lestra_realtime_resolve_academia(tg_table_name, v_row);
  if v_academia is not null then
    insert into public.lestra_realtime_state (academia_id, scope, revision, changed_at)
    values (v_academia, tg_table_name, 1, now())
    on conflict (academia_id, scope)
    do update set
      revision = public.lestra_realtime_state.revision + 1,
      changed_at = excluded.changed_at;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.lestra_realtime_bump() from public, anon, authenticated;
grant execute on function public.lestra_realtime_bump() to service_role;

-- Attach one lightweight AFTER trigger to business tables that carry academia_id.
do $$
declare
  r record;
  trigger_name text;
begin
  for r in
    select c.table_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema
     and t.table_name = c.table_name
    where c.table_schema = 'public'
      and c.column_name = 'academia_id'
      and t.table_type = 'BASE TABLE'
      and c.table_name <> 'lestra_realtime_state'
      and c.table_name not in ('chat_messages')
  loop
    trigger_name := 'lestra_rt_' || substr(md5(r.table_name), 1, 12);
    execute format('drop trigger if exists %I on public.%I', trigger_name, r.table_name);
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function public.lestra_realtime_bump()',
      trigger_name,
      r.table_name
    );
  end loop;
end $$;

-- Attach resolvers for important child tables that do not carry academia_id themselves.
do $$
declare
  table_name text;
  trigger_name text;
begin
  foreach table_name in array array[
    'academias',
    'asistencias',
    'jugador_categoria',
    'jugador_insignias',
    'jugador_tutor',
    'partido_citaciones',
    'partido_estadisticas',
    'partido_plan_jugadores',
    'payment_gateway_order_items',
    'whatsapp_group_members'
  ]
  loop
    if to_regclass(format('public.%I', table_name)) is not null then
      trigger_name := 'lestra_rt_' || substr(md5(table_name), 1, 12);
      execute format('drop trigger if exists %I on public.%I', trigger_name, table_name);
      execute format(
        'create trigger %I after insert or update or delete on public.%I for each row execute function public.lestra_realtime_bump()',
        trigger_name,
        table_name
      );
    end if;
  end loop;
end $$;

-- Publish only the neutral synchronization state table, never the underlying sensitive tables.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'lestra_realtime_state'
  ) then
    alter publication supabase_realtime add table public.lestra_realtime_state;
  end if;
end $$;
