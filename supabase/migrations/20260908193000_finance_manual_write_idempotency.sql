alter table public.cobros add column if not exists idempotency_key text;
alter table public.egresos add column if not exists idempotency_key text;

create unique index if not exists cobros_academia_idempotency_key_unique
  on public.cobros (academia_id, idempotency_key)
  where idempotency_key is not null;

create unique index if not exists egresos_academia_idempotency_key_unique
  on public.egresos (academia_id, idempotency_key)
  where idempotency_key is not null;

comment on column public.cobros.idempotency_key is 'Clave estable del cliente para evitar duplicar cobros manuales ante reintentos ambiguos.';
comment on column public.egresos.idempotency_key is 'Clave estable del cliente para evitar duplicar egresos manuales ante reintentos ambiguos.';
