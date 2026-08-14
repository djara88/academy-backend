-- Control comercial y contable de la plataforma Syncademia.

alter table public.academias
  add column if not exists trial_started_at timestamptz,
  add column if not exists trial_ends_at timestamptz,
  add column if not exists subscription_status text not null default 'active',
  add column if not exists blocked_at timestamptz,
  add column if not exists blocked_reason text,
  add column if not exists next_billing_date date,
  add column if not exists plan_price_uf numeric(8,2) not null default 0,
  add column if not exists guardian_price_uf numeric(8,2) not null default 0;

alter table public.academias drop constraint if exists academias_subscription_status_check;
alter table public.academias add constraint academias_subscription_status_check
  check (subscription_status in ('trialing', 'active', 'past_due', 'suspended', 'cancelled'));
alter table public.academias drop constraint if exists academias_plan_price_uf_check;
alter table public.academias add constraint academias_plan_price_uf_check check (plan_price_uf >= 0);
alter table public.academias drop constraint if exists academias_guardian_price_uf_check;
alter table public.academias add constraint academias_guardian_price_uf_check check (guardian_price_uf >= 0);

update public.academias
set
  trial_started_at = coalesce(trial_started_at, created_at),
  trial_ends_at = coalesce(trial_ends_at, created_at + interval '15 days'),
  subscription_status = case
    when coalesce(trial_ends_at, created_at + interval '15 days') <= now() then 'suspended'
    else 'trialing'
  end,
  estado = case
    when coalesce(trial_ends_at, created_at + interval '15 days') <= now() then 'Bloqueada'
    else 'Activa'
  end,
  blocked_at = case
    when coalesce(trial_ends_at, created_at + interval '15 days') <= now() then coalesce(blocked_at, now())
    else null
  end,
  blocked_reason = case
    when coalesce(trial_ends_at, created_at + interval '15 days') <= now() then coalesce(blocked_reason, 'Prueba gratuita vencida')
    else null
  end,
  plan_price_uf = 0,
  guardian_price_uf = 0
where lower(coalesce(plan, '')) like '%prueba%';

update public.academias
set
  subscription_status = 'active',
  plan_price_uf = case plan_codigo
    when 'competencia' then 1.50
    when 'alto_rendimiento' then 2.50
    else 0.75
  end,
  guardian_price_uf = case when licencia_apoderados then 0.35 else 0 end,
  next_billing_date = coalesce(next_billing_date, (current_date + interval '1 month')::date)
where lower(coalesce(plan, '')) not like '%prueba%'
  and plan_price_uf = 0;

create index if not exists idx_academias_trial_ends_at
  on public.academias (trial_ends_at)
  where subscription_status = 'trialing';
create index if not exists idx_academias_subscription_status
  on public.academias (subscription_status, estado);

create table if not exists public.plataforma_cobros (
  id uuid primary key default gen_random_uuid(),
  academia_id uuid not null references public.academias(id) on delete restrict,
  concepto text not null,
  periodo_inicio date,
  periodo_fin date,
  subtotal_clp bigint not null default 0 check (subtotal_clp >= 0),
  addon_clp bigint not null default 0 check (addon_clp >= 0),
  uf_value numeric(12,2),
  target_plan_code text check (target_plan_code is null or target_plan_code in ('formacion', 'competencia', 'alto_rendimiento')),
  target_guardian_license boolean not null default false,
  total_clp bigint generated always as (subtotal_clp + addon_clp) stored,
  fecha_emision date not null default current_date,
  fecha_vencimiento date not null,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'pagado', 'vencido', 'anulado')),
  pagado_at timestamptz,
  metodo_pago text,
  referencia text,
  flow_order bigint,
  flow_token text,
  checkout_url text,
  notas text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_plataforma_cobros_academia on public.plataforma_cobros (academia_id, fecha_vencimiento desc);
create index if not exists idx_plataforma_cobros_estado on public.plataforma_cobros (estado, fecha_vencimiento);

create table if not exists public.plataforma_movimientos (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('ingreso', 'egreso')),
  cobro_id uuid references public.plataforma_cobros(id) on delete restrict,
  academia_id uuid references public.academias(id) on delete restrict,
  categoria text not null,
  descripcion text not null,
  monto_clp bigint not null check (monto_clp > 0),
  fecha date not null default current_date,
  metodo_pago text,
  referencia text,
  notas text,
  created_by uuid,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_plataforma_movimientos_cobro_ingreso
  on public.plataforma_movimientos (cobro_id)
  where tipo = 'ingreso' and cobro_id is not null;
create index if not exists idx_plataforma_movimientos_fecha on public.plataforma_movimientos (fecha desc, tipo);

alter table public.plataforma_cobros enable row level security;
alter table public.plataforma_movimientos enable row level security;
revoke all on public.plataforma_cobros from anon, authenticated;
revoke all on public.plataforma_movimientos from anon, authenticated;
grant all on public.plataforma_cobros to service_role;
grant all on public.plataforma_movimientos to service_role;

create or replace function public.refrescar_pruebas_vencidas()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  update public.academias
  set subscription_status = 'suspended',
      estado = 'Bloqueada',
      blocked_at = coalesce(blocked_at, now()),
      blocked_reason = coalesce(blocked_reason, 'Prueba gratuita vencida')
  where subscription_status = 'trialing'
    and trial_ends_at is not null
    and trial_ends_at <= now();
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.refrescar_pruebas_vencidas() from public, anon, authenticated;
grant execute on function public.refrescar_pruebas_vencidas() to service_role;

create or replace function public.marcar_cobro_plataforma_pagado(
  p_cobro_id uuid,
  p_created_by uuid,
  p_metodo_pago text default null,
  p_referencia text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  charge public.plataforma_cobros%rowtype;
  movement_id uuid;
begin
  update public.plataforma_cobros
  set estado = 'pagado',
      pagado_at = coalesce(pagado_at, now()),
      metodo_pago = coalesce(nullif(trim(p_metodo_pago), ''), metodo_pago),
      referencia = coalesce(nullif(trim(p_referencia), ''), referencia),
      updated_at = now()
  where id = p_cobro_id and estado <> 'anulado'
  returning * into charge;

  if charge.id is null then
    raise exception 'Cobro no encontrado o anulado';
  end if;

  insert into public.plataforma_movimientos (
    tipo, cobro_id, academia_id, categoria, descripcion, monto_clp,
    fecha, metodo_pago, referencia, created_by
  ) values (
    'ingreso', charge.id, charge.academia_id, 'Suscripciones', charge.concepto,
    charge.total_clp, coalesce(charge.pagado_at::date, current_date),
    charge.metodo_pago, charge.referencia, p_created_by
  )
  on conflict (cobro_id) where tipo = 'ingreso' and cobro_id is not null
  do update set metodo_pago = excluded.metodo_pago, referencia = excluded.referencia
  returning id into movement_id;

  return movement_id;
end;
$$;

revoke all on function public.marcar_cobro_plataforma_pagado(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.marcar_cobro_plataforma_pagado(uuid, uuid, text, text) to service_role;
