-- LESTRA · Profesor Ops v1
-- Extiende el módulo del profesor sin alterar asignaciones por categoría/rama.

alter table public.partidos
  add column if not exists en_vivo boolean not null default false,
  add column if not exists live_etapa text not null default '',
  add column if not exists live_started_at timestamptz,
  add column if not exists live_finished_at timestamptz,
  add column if not exists live_updated_at timestamptz,
  add column if not exists live_updated_by uuid references public.usuarios(id) on delete set null;

create index if not exists partidos_live_academia_idx
  on public.partidos (academia_id, fecha, live_updated_at desc)
  where en_vivo = true;

create table if not exists public.partido_live_eventos (
  id uuid primary key default gen_random_uuid(),
  academia_id uuid not null references public.academias(id) on delete cascade,
  partido_id uuid not null references public.partidos(id) on delete cascade,
  profesor_id uuid references public.usuarios(id) on delete set null,
  jugador_id uuid references public.jugadores(id) on delete set null,
  accion text not null,
  detalle jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint partido_live_eventos_accion_check check (accion in ('inicio','marcador','etapa','estadistica','nota','fin'))
);

create index if not exists partido_live_eventos_partido_idx
  on public.partido_live_eventos (partido_id, created_at desc);
create index if not exists partido_live_eventos_academia_idx
  on public.partido_live_eventos (academia_id, created_at desc);

create table if not exists public.profesor_casos (
  id uuid primary key default gen_random_uuid(),
  academia_id uuid not null references public.academias(id) on delete cascade,
  profesor_id uuid references public.usuarios(id) on delete set null,
  creado_por uuid references public.usuarios(id) on delete set null,
  origen text not null default 'profesor',
  categoria_id uuid references public.categorias(id) on delete set null,
  rama_id uuid references public.ramas(id) on delete set null,
  jugador_id uuid references public.jugadores(id) on delete set null,
  tipo text not null default 'seguimiento',
  prioridad text not null default 'normal',
  titulo text not null,
  detalle text not null default '',
  estado text not null default 'abierto',
  resuelto_por uuid references public.usuarios(id) on delete set null,
  resuelto_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profesor_casos_origen_check check (origen in ('profesor','direccion')),
  constraint profesor_casos_tipo_check check (tipo in ('seguimiento','conducta','salud','asistencia','familiar','operativo','feedback','otro')),
  constraint profesor_casos_prioridad_check check (prioridad in ('baja','normal','alta','urgente')),
  constraint profesor_casos_estado_check check (estado in ('abierto','en_revision','resuelto')),
  constraint profesor_casos_titulo_length check (char_length(titulo) between 3 and 160),
  constraint profesor_casos_detalle_length check (char_length(detalle) <= 5000)
);

create index if not exists profesor_casos_academia_estado_idx
  on public.profesor_casos (academia_id, estado, updated_at desc);
create index if not exists profesor_casos_profesor_idx
  on public.profesor_casos (profesor_id, estado, updated_at desc);
create index if not exists profesor_casos_categoria_idx
  on public.profesor_casos (categoria_id, updated_at desc);
create index if not exists profesor_casos_jugador_idx
  on public.profesor_casos (jugador_id, updated_at desc)
  where jugador_id is not null;

create table if not exists public.profesor_caso_mensajes (
  id uuid primary key default gen_random_uuid(),
  caso_id uuid not null references public.profesor_casos(id) on delete cascade,
  academia_id uuid not null references public.academias(id) on delete cascade,
  autor_id uuid references public.usuarios(id) on delete set null,
  autor_rol text not null,
  mensaje text not null,
  created_at timestamptz not null default now(),
  constraint profesor_caso_mensajes_autor_rol_check check (autor_rol in ('profesor','director')),
  constraint profesor_caso_mensajes_length check (char_length(mensaje) between 1 and 5000)
);

create index if not exists profesor_caso_mensajes_caso_idx
  on public.profesor_caso_mensajes (caso_id, created_at);

alter table public.partido_live_eventos enable row level security;
alter table public.profesor_casos enable row level security;
alter table public.profesor_caso_mensajes enable row level security;

revoke all on table public.partido_live_eventos from anon, authenticated;
revoke all on table public.profesor_casos from anon, authenticated;
revoke all on table public.profesor_caso_mensajes from anon, authenticated;

grant select, insert, update, delete on table public.partido_live_eventos to service_role;
grant select, insert, update, delete on table public.profesor_casos to service_role;
grant select, insert, update, delete on table public.profesor_caso_mensajes to service_role;

comment on column public.partidos.en_vivo is 'Indica que el encuentro está siendo operado en tiempo real desde el portal del profesor.';
comment on column public.partidos.live_etapa is 'Periodo, set, tiempo o etapa libre informada por el profesor durante el encuentro.';
comment on table public.partido_live_eventos is 'Bitácora auditable de cambios efectuados durante la operación en vivo de un encuentro.';
comment on table public.profesor_casos is 'Casos operativos y feedback estructurado entre profesor y dirección, acotados por academia y opcionalmente por categoría/jugador.';
comment on table public.profesor_caso_mensajes is 'Conversación auditada asociada a un caso entre profesor y dirección.';
