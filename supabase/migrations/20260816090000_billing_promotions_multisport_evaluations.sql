-- Syncademia: facturación anual/fundadores + metadatos de evaluación multideporte

alter table public.academias
  add column if not exists billing_cycle text not null default 'monthly',
  add column if not exists billing_amount_clp bigint not null default 0,
  add column if not exists promotion_code text,
  add column if not exists promotion_ends_at date,
  add column if not exists founder_number smallint;

alter table public.plataforma_cobros
  add column if not exists billing_cycle text not null default 'monthly',
  add column if not exists promotion_code text,
  add column if not exists discount_clp bigint not null default 0,
  add column if not exists billing_period_months smallint not null default 1,
  add column if not exists founder_slot smallint;

alter table public.evaluaciones
  add column if not exists disciplina_codigo text,
  add column if not exists perfil_evaluacion text,
  add column if not exists metricas_version smallint not null default 1;

alter table public.ramas
  add column if not exists config_evaluacion jsonb not null default '{}'::jsonb;

create unique index if not exists academias_founder_number_uidx
  on public.academias(founder_number)
  where founder_number is not null;

create index if not exists evaluaciones_disciplina_rama_idx
  on public.evaluaciones(academia_id, rama_id, disciplina_codigo, created_at desc);

create table if not exists public.syncademia_founder_slots (
  slot_no smallint primary key check (slot_no between 1 and 10),
  academia_id uuid unique references public.academias(id) on delete cascade,
  charge_id uuid unique references public.plataforma_cobros(id) on delete set null,
  reserved_until timestamptz,
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.syncademia_founder_slots(slot_no)
select n::smallint from generate_series(1, 10) as n
on conflict (slot_no) do nothing;

alter table public.syncademia_founder_slots enable row level security;

create or replace function public.reservar_syncademia_founder_slot(
  p_academia_id uuid,
  p_charge_id uuid
) returns smallint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slot smallint;
begin
  update public.syncademia_founder_slots
     set academia_id = null,
         charge_id = null,
         reserved_until = null,
         updated_at = now()
   where activated_at is null
     and reserved_until is not null
     and reserved_until < now();

  select slot_no
    into v_slot
    from public.syncademia_founder_slots
   where academia_id = p_academia_id
     and (activated_at is not null or reserved_until >= now())
   order by slot_no
   limit 1
   for update;

  if v_slot is not null then
    update public.syncademia_founder_slots
       set charge_id = p_charge_id,
           reserved_until = case when activated_at is null then now() + interval '3 days' else reserved_until end,
           updated_at = now()
     where slot_no = v_slot;
    return v_slot;
  end if;

  select slot_no
    into v_slot
    from public.syncademia_founder_slots
   where academia_id is null
   order by slot_no
   limit 1
   for update skip locked;

  if v_slot is null then
    return null;
  end if;

  update public.syncademia_founder_slots
     set academia_id = p_academia_id,
         charge_id = p_charge_id,
         reserved_until = now() + interval '3 days',
         updated_at = now()
   where slot_no = v_slot;

  return v_slot;
end;
$$;

create or replace function public.activar_syncademia_founder_slot(
  p_academia_id uuid,
  p_charge_id uuid
) returns smallint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slot smallint;
begin
  select slot_no
    into v_slot
    from public.syncademia_founder_slots
   where academia_id = p_academia_id
     and charge_id = p_charge_id
     and (activated_at is not null or reserved_until >= now())
   limit 1
   for update;

  if v_slot is null then
    return null;
  end if;

  update public.syncademia_founder_slots
     set activated_at = coalesce(activated_at, now()),
         reserved_until = null,
         updated_at = now()
   where slot_no = v_slot;

  return v_slot;
end;
$$;

revoke all on function public.reservar_syncademia_founder_slot(uuid, uuid) from public;
revoke all on function public.activar_syncademia_founder_slot(uuid, uuid) from public;
grant execute on function public.reservar_syncademia_founder_slot(uuid, uuid) to service_role;
grant execute on function public.activar_syncademia_founder_slot(uuid, uuid) to service_role;
