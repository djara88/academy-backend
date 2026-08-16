create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create or replace function private.can_access_chat_conversation(target_conversation uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.chat_conversations c
    where c.id = target_conversation
      and c.estado in ('activa','cerrada')
      and (
        exists (
          select 1 from public.chat_participants p
          where p.conversation_id = c.id
            and p.user_id = auth.uid()
            and p.active = true
        )
        or exists (
          select 1 from public.usuarios u
          where u.id = auth.uid()
            and u.academia_id = c.academia_id
            and lower(coalesce(u.rol,'')) = 'director'
            and u.activo is distinct from false
        )
      )
  );
$$;

revoke all on function private.can_access_chat_conversation(uuid) from public;
grant execute on function private.can_access_chat_conversation(uuid) to authenticated;

alter policy chat_messages_realtime_select on public.chat_messages
using (private.can_access_chat_conversation(conversation_id));

revoke all on function public.can_access_chat_conversation(uuid) from authenticated;
drop function public.can_access_chat_conversation(uuid);
