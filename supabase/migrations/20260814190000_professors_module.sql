alter table public.academias
  add column if not exists max_profesores integer;

update public.academias
set max_profesores = case
  when lower(coalesce(plan, '')) like '%alto rendimiento%' or lower(coalesce(plan, '')) like '%elite%' then 15
  when lower(coalesce(plan, '')) like '%competencia%' or lower(coalesce(plan, '')) like '%pro%' then 6
  else 2
end
where max_profesores is null;

alter table public.academias
  alter column max_profesores set default 2,
  alter column max_profesores set not null;

alter table public.academias
  drop constraint if exists academias_max_profesores_check;

alter table public.academias
  add constraint academias_max_profesores_check check (max_profesores > 0);

create table if not exists public.profesor_categorias (
  id uuid primary key default gen_random_uuid(),
  academia_id uuid not null references public.academias(id) on delete cascade,
  profesor_id uuid not null references public.usuarios(id) on delete cascade,
  categoria_id uuid not null references public.categorias(id) on delete cascade,
  assigned_by uuid references public.usuarios(id) on delete set null,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists profesor_categorias_titular_activo_uidx
  on public.profesor_categorias (categoria_id) where activo;

create unique index if not exists profesor_categorias_par_activo_uidx
  on public.profesor_categorias (profesor_id, categoria_id) where activo;

create index if not exists profesor_categorias_profesor_activo_idx
  on public.profesor_categorias (profesor_id, activo);

create index if not exists profesor_categorias_academia_activo_idx
  on public.profesor_categorias (academia_id, activo);

create index if not exists usuarios_academia_rol_activo_idx
  on public.usuarios (academia_id, rol, activo);

create index if not exists categorias_academia_idx
  on public.categorias (academia_id);

alter table public.entrenamientos
  add column if not exists registrado_por uuid references public.usuarios(id) on delete set null;

alter table public.asistencias
  add column if not exists registrado_por uuid references public.usuarios(id) on delete set null,
  add column if not exists actualizado_at timestamptz;

alter table public.profesor_categorias enable row level security;
revoke all on table public.profesor_categorias from anon, authenticated;
grant select, insert, update, delete on table public.profesor_categorias to service_role;

comment on table public.profesor_categorias is 'Asignaciones privadas de profesores titulares a categorías, administradas solo por el backend.';
comment on column public.academias.max_profesores is 'Cupo contratado de profesores; permite ampliaciones particulares por academia.';
