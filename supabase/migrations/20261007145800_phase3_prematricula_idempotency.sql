alter table public.prematriculas
  add column if not exists idempotency_key text,
  add column if not exists idempotency_fingerprint text;

create unique index if not exists prematriculas_academia_idempotency_uq
  on public.prematriculas (academia_id, idempotency_key)
  where idempotency_key is not null;
