-- Evita que los triggers Realtime intenten crear un evento para una academia
-- que ya fue eliminada (por ejemplo durante un DELETE CASCADE de academias).
-- Mantiene el comportamiento normal para cambios de entidades cuya academia sigue activa.

create or replace function public.lestra_realtime_bump()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row jsonb;
  v_academia uuid;
  v_txid bigint := txid_current();
begin
  if tg_op = 'DELETE' then
    v_row := to_jsonb(old);
  else
    v_row := to_jsonb(new);
  end if;

  v_academia := public.lestra_realtime_resolve_academia(tg_table_name, v_row);

  -- Durante un borrado de academia (incluido CASCADE), la fila padre puede
  -- haber dejado de ser visible antes de que corran triggers AFTER en hijos.
  -- En ese caso no hay consumidores válidos para el evento y debemos omitirlo.
  if v_academia is not null
     and exists (select 1 from public.academias a where a.id = v_academia) then
    insert into public.lestra_realtime_state (academia_id, scope, revision, changed_at, last_txid)
    values (v_academia, tg_table_name, 1, clock_timestamp(), v_txid)
    on conflict (academia_id, scope)
    do update set
      revision = public.lestra_realtime_state.revision + 1,
      changed_at = excluded.changed_at,
      last_txid = excluded.last_txid
    where public.lestra_realtime_state.last_txid is distinct from excluded.last_txid;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.lestra_realtime_bump() from public, anon, authenticated;
grant execute on function public.lestra_realtime_bump() to service_role;
