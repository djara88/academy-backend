create table if not exists public.site_admin_notifications (
  id uuid primary key default gen_random_uuid(),
  academia_id uuid not null references public.academias(id) on delete cascade,
  tipo text not null default 'new_academy',
  status text not null default 'pending' check (status in ('pending','processing','sent','failed','ignored_existing')),
  recipient text,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  processing_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (academia_id, tipo)
);

alter table public.site_admin_notifications enable row level security;
revoke all on table public.site_admin_notifications from anon, authenticated;

insert into public.site_admin_notifications (academia_id, tipo, status, sent_at, last_error)
select a.id, 'new_academy', 'ignored_existing', now(), 'Registro existente antes de habilitar alertas de nuevas academias'
from public.academias a
on conflict (academia_id, tipo) do nothing;

create or replace function public.queue_new_academy_admin_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.site_admin_notifications (academia_id, tipo, status, next_attempt_at)
  values (new.id, 'new_academy', 'pending', now())
  on conflict (academia_id, tipo) do nothing;
  return new;
end;
$$;

revoke all on function public.queue_new_academy_admin_notification() from public, anon, authenticated;

drop trigger if exists trg_queue_new_academy_admin_notification on public.academias;
create trigger trg_queue_new_academy_admin_notification
after insert on public.academias
for each row execute function public.queue_new_academy_admin_notification();

create index if not exists idx_site_admin_notifications_pending
on public.site_admin_notifications (status, next_attempt_at, created_at);
