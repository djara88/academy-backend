create table if not exists public.lestra_products (
  code text primary key,
  name text not null,
  status text not null default 'design' check (status in ('active','design','paused','retired')),
  app_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lestra_products_code_format check (code ~ '^[a-z0-9_-]+$')
);

create table if not exists public.lestra_organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active' check (status in ('active','inactive','archived')),
  source_product text not null references public.lestra_products(code),
  source_entity_id uuid not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_product, source_entity_id)
);

create table if not exists public.lestra_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.lestra_organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null,
  status text not null default 'active' check (status in ('active','inactive','pending')),
  source_product text not null references public.lestra_products(code),
  source_entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id, source_product)
);

create table if not exists public.lestra_product_access (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.lestra_organizations(id) on delete cascade,
  product_code text not null references public.lestra_products(code),
  status text not null default 'pending' check (status in ('active','trial','pending','paused','cancelled','inactive')),
  plan_code text,
  source_entity_id uuid,
  started_at timestamptz,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, product_code)
);

create index if not exists idx_lestra_memberships_user on public.lestra_memberships(user_id, status);
create index if not exists idx_lestra_product_access_product on public.lestra_product_access(product_code, status);

alter table public.lestra_products enable row level security;
alter table public.lestra_organizations enable row level security;
alter table public.lestra_memberships enable row level security;
alter table public.lestra_product_access enable row level security;

revoke all on public.lestra_products from anon, authenticated;
revoke all on public.lestra_organizations from anon, authenticated;
revoke all on public.lestra_memberships from anon, authenticated;
revoke all on public.lestra_product_access from anon, authenticated;

insert into public.lestra_products (code, name, status, app_url)
values
  ('deportivo', 'Lestra Deportivo', 'active', 'https://deportivo.lestra.app'),
  ('learn', 'Lestra Learn', 'design', 'https://learn.lestra.app'),
  ('profe', 'Lestra Profe', 'design', 'https://profe.lestra.app')
on conflict (code) do update set
  name = excluded.name,
  status = excluded.status,
  app_url = excluded.app_url,
  updated_at = now();

insert into public.lestra_organizations (name, status, source_product, source_entity_id, created_at, updated_at)
select a.nombre, 'active', 'deportivo', a.id, coalesce(a.created_at, now()), now()
from public.academias a
on conflict (source_product, source_entity_id) do update set
  name = excluded.name,
  status = excluded.status,
  updated_at = now();

insert into public.lestra_product_access (
  organization_id, product_code, status, plan_code, source_entity_id, started_at, expires_at, created_at, updated_at
)
select o.id,
       'deportivo',
       case
         when a.subscription_status = 'active' then 'active'
         when a.subscription_status = 'trialing' then 'trial'
         when a.subscription_status in ('cancelled','canceled') then 'cancelled'
         when a.subscription_status in ('paused','past_due') then 'paused'
         else 'inactive'
       end,
       a.plan_codigo,
       a.id,
       coalesce(a.trial_started_at, a.created_at),
       a.trial_ends_at,
       coalesce(a.created_at, now()),
       now()
from public.academias a
join public.lestra_organizations o
  on o.source_product = 'deportivo' and o.source_entity_id = a.id
on conflict (organization_id, product_code) do update set
  status = excluded.status,
  plan_code = excluded.plan_code,
  source_entity_id = excluded.source_entity_id,
  started_at = excluded.started_at,
  expires_at = excluded.expires_at,
  updated_at = now();

insert into public.lestra_memberships (
  organization_id, user_id, role, status, source_product, source_entity_id, created_at, updated_at
)
select o.id,
       u.id,
       coalesce(nullif(trim(u.rol), ''), 'member'),
       case when u.activo is false then 'inactive' else 'active' end,
       'deportivo',
       u.id,
       coalesce(u.created_at, now()),
       now()
from public.usuarios u
join public.lestra_organizations o
  on o.source_product = 'deportivo' and o.source_entity_id = u.academia_id
where u.academia_id is not null
on conflict (organization_id, user_id, source_product) do update set
  role = excluded.role,
  status = excluded.status,
  source_entity_id = excluded.source_entity_id,
  updated_at = now();