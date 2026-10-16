-- Phase 5: a disabled Supabase-auth user must not retain direct read access
-- to academy data or Realtime chat while a previously issued JWT remains valid.
-- Backend service_role operations and existing privileges remain unchanged.
alter policy academias_lectura_propia on public.academias
using (
  exists (
    select 1 from public.usuarios u
    where u.id = (select auth.uid())
      and u.academia_id = academias.id
      and u.activo is distinct from false
  )
);

-- Restrict the chat SECURITY DEFINER helper used by chat_messages RLS.
-- Profiles remain readable to their own user so the UI can identify a disabled account.
CREATE OR REPLACE FUNCTION private.can_access_chat_conversation(target_conversation uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select exists (
    select 1
    from public.chat_conversations c
    where c.id = target_conversation
      and c.estado in ('activa','cerrada')
      and exists (
        select 1 from public.usuarios active_user
        where active_user.id = auth.uid()
          and active_user.academia_id = c.academia_id
          and active_user.activo is distinct from false
      )
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
$function$
;
