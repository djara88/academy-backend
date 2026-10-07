alter table public.payment_gateway_orders
  add column if not exists idempotency_key text;

create unique index if not exists payment_gateway_orders_active_idempotency_uq
  on public.payment_gateway_orders (academia_id, idempotency_key)
  where idempotency_key is not null
    and status in ('created','pending');

drop index if exists public.prematriculas_academia_idempotency_uq;

create unique index prematriculas_academia_idempotency_uq
  on public.prematriculas (academia_id, idempotency_key)
  where idempotency_key is not null
    and estado in ('enviada','abierta','procesando');
