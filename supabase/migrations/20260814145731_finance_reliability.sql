-- Financial reliability: immutable payment ledger, idempotent charges and
-- server-only access to sensitive financial tables.

alter table public.cobros
  add column if not exists metodo_pago text,
  add column if not exists fecha_pago timestamptz,
  add column if not exists observaciones text;

alter table public.egresos
  add column if not exists anulado_at timestamptz,
  add column if not exists anulado_por uuid;

create table if not exists public.pagos (
  id uuid primary key default gen_random_uuid(),
  academia_id uuid not null references public.academias(id) on delete cascade,
  cobro_id uuid not null references public.cobros(id) on delete cascade,
  jugador_id uuid references public.jugadores(id) on delete set null,
  monto numeric(12, 2) not null check (monto > 0),
  metodo_pago text not null default 'Transferencia',
  fecha_pago timestamptz not null default now(),
  observaciones text,
  comprobante_ref text,
  idempotency_key text,
  registrado_por uuid,
  created_at timestamptz not null default now(),
  unique (academia_id, idempotency_key)
);

alter table public.pagos enable row level security;

create index if not exists pagos_academia_fecha_idx
  on public.pagos (academia_id, fecha_pago desc);
create index if not exists pagos_cobro_fecha_idx
  on public.pagos (cobro_id, fecha_pago desc);
create index if not exists pagos_jugador_fecha_idx
  on public.pagos (jugador_id, fecha_pago desc)
  where jugador_id is not null;
create index if not exists cobros_academia_estado_idx
  on public.cobros (academia_id, estado);
create index if not exists cobros_jugador_idx
  on public.cobros (jugador_id);
create index if not exists egresos_academia_fecha_idx
  on public.egresos (academia_id, fecha_gasto desc);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'cobros_academia_jugador_torneo_key'
      and conrelid = 'public.cobros'::regclass
  ) then
    alter table public.cobros
      add constraint cobros_academia_jugador_torneo_key
      unique (academia_id, jugador_id, torneo_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'cobros_academia_jugador_partido_key'
      and conrelid = 'public.cobros'::regclass
  ) then
    alter table public.cobros
      add constraint cobros_academia_jugador_partido_key
      unique (academia_id, jugador_id, partido_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'configuracion_financiera_academia_id_fkey'
      and conrelid = 'public.configuracion_financiera'::regclass
  ) then
    alter table public.configuracion_financiera
      add constraint configuracion_financiera_academia_id_fkey
      foreign key (academia_id) references public.academias(id) on delete cascade;
  end if;
end $$;

-- Preserve the money already recorded before introducing the payment ledger.
insert into public.pagos (
  academia_id,
  cobro_id,
  jugador_id,
  monto,
  metodo_pago,
  fecha_pago,
  observaciones,
  idempotency_key
)
select
  c.academia_id,
  c.id,
  c.jugador_id,
  c.monto_pagado,
  coalesce(nullif(c.metodo_pago, ''), 'Sin registrar'),
  coalesce(c.fecha_pago, c.created_at, now()),
  'Saldo histórico migrado desde cobros',
  'legacy-cobro-' || c.id::text
from public.cobros c
where c.academia_id is not null
  and coalesce(c.monto_pagado, 0) > 0
on conflict (academia_id, idempotency_key) do nothing;

create or replace function public.registrar_pago_cobro(
  p_academia_id uuid,
  p_cobro_id uuid,
  p_monto numeric,
  p_metodo_pago text,
  p_observaciones text default null,
  p_idempotency_key text default null,
  p_usuario_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cobro public.cobros%rowtype;
  v_cobro_actualizado public.cobros%rowtype;
  v_pago public.pagos%rowtype;
  v_pagado numeric(12, 2);
  v_saldo numeric(12, 2);
  v_estado text;
begin
  if p_monto is null or p_monto <= 0 then
    raise exception 'El monto del pago debe ser mayor que cero';
  end if;

  if p_idempotency_key is not null then
    select * into v_pago
    from public.pagos
    where academia_id = p_academia_id
      and idempotency_key = p_idempotency_key;

    if found then
      select * into v_cobro_actualizado
      from public.cobros
      where id = v_pago.cobro_id;

      return jsonb_build_object(
        'pago', to_jsonb(v_pago),
        'cobro', to_jsonb(v_cobro_actualizado),
        'idempotente', true
      );
    end if;
  end if;

  select * into v_cobro
  from public.cobros
  where id = p_cobro_id
    and academia_id = p_academia_id
  for update;

  if not found then
    raise exception 'Cobro no encontrado para la academia';
  end if;

  if v_cobro.estado = 'Anulado' then
    raise exception 'No se puede pagar un cobro anulado';
  end if;

  v_saldo := greatest(coalesce(v_cobro.monto, 0) - coalesce(v_cobro.monto_pagado, 0), 0);
  if p_monto > v_saldo then
    raise exception 'El pago supera el saldo pendiente de %', v_saldo;
  end if;

  insert into public.pagos (
    academia_id,
    cobro_id,
    jugador_id,
    monto,
    metodo_pago,
    observaciones,
    idempotency_key,
    registrado_por
  ) values (
    p_academia_id,
    p_cobro_id,
    v_cobro.jugador_id,
    p_monto,
    coalesce(nullif(trim(p_metodo_pago), ''), 'Sin registrar'),
    nullif(trim(p_observaciones), ''),
    p_idempotency_key,
    p_usuario_id
  )
  returning * into v_pago;

  v_pagado := coalesce(v_cobro.monto_pagado, 0) + p_monto;
  v_estado := case
    when v_pagado >= coalesce(v_cobro.monto, 0) then 'Pagado'
    else 'Parcial'
  end;

  update public.cobros
  set monto_pagado = v_pagado,
      estado = v_estado,
      metodo_pago = v_pago.metodo_pago,
      fecha_pago = v_pago.fecha_pago,
      observaciones = case
        when v_pago.observaciones is null then cobros.observaciones
        else concat_ws(' | ', nullif(cobros.observaciones, ''), v_pago.observaciones)
      end
  where id = v_cobro.id
    and academia_id = p_academia_id
  returning * into v_cobro_actualizado;

  if v_cobro.jugador_id is not null then
    update public.jugadores j
    set estado_financiero = case
      when exists (
        select 1
        from public.cobros c
        where c.academia_id = p_academia_id
          and c.jugador_id = v_cobro.jugador_id
          and c.estado not in ('Pagado', 'Anulado')
          and coalesce(c.monto, 0) > coalesce(c.monto_pagado, 0)
      ) then 'Moroso'
      else 'Al Día'
    end,
    ultimo_pago_fecha = v_pago.fecha_pago::date
    where j.id = v_cobro.jugador_id
      and j.academia_id = p_academia_id;
  end if;

  update public.pedidos_indumentaria
  set estado_pago = case when v_estado = 'Pagado' then 'Pagado' else 'Abonado' end
  where cobro_id = v_cobro.id
    and academia_id = p_academia_id;

  if v_cobro.torneo_id is not null and v_cobro.jugador_id is not null then
    update public.torneo_participantes
    set estado_pago = v_estado
    where torneo_id = v_cobro.torneo_id
      and jugador_id = v_cobro.jugador_id;
  end if;

  return jsonb_build_object(
    'pago', to_jsonb(v_pago),
    'cobro', to_jsonb(v_cobro_actualizado),
    'idempotente', false
  );
end;
$$;

revoke all on function public.registrar_pago_cobro(uuid, uuid, numeric, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.registrar_pago_cobro(uuid, uuid, numeric, text, text, text, uuid)
  to service_role;
