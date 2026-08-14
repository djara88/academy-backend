create table public.entrenamiento_bitacoras (
  id uuid primary key default gen_random_uuid(),
  academia_id uuid not null references public.academias(id) on delete cascade,
  entrenamiento_id uuid not null references public.entrenamientos(id) on delete cascade,
  categoria_id uuid not null references public.categorias(id) on delete cascade,
  profesor_id uuid references public.usuarios(id) on delete set null,
  objetivo text not null default '',
  contenidos text not null default '',
  observaciones text not null default '',
  incidencias text not null default '',
  intensidad text not null default 'Media',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint entrenamiento_bitacoras_entrenamiento_unique unique (entrenamiento_id),
  constraint entrenamiento_bitacoras_intensidad_check check (intensidad in ('Baja', 'Media', 'Alta'))
);

create index entrenamiento_bitacoras_academia_categoria_idx
  on public.entrenamiento_bitacoras (academia_id, categoria_id, updated_at desc);
create index entrenamiento_bitacoras_profesor_idx
  on public.entrenamiento_bitacoras (profesor_id);

create table public.alertas_asistencia (
  id uuid primary key default gen_random_uuid(),
  academia_id uuid not null references public.academias(id) on delete cascade,
  categoria_id uuid not null references public.categorias(id) on delete cascade,
  jugador_id uuid not null references public.jugadores(id) on delete cascade,
  tipo text not null default 'ausencias_consecutivas',
  racha integer not null default 0,
  activa boolean not null default false,
  detectada_at timestamptz,
  ultima_ausencia date,
  revisada_at timestamptz,
  revisada_por uuid references public.usuarios(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint alertas_asistencia_unica unique (academia_id, categoria_id, jugador_id, tipo),
  constraint alertas_asistencia_tipo_check check (tipo in ('ausencias_consecutivas')),
  constraint alertas_asistencia_racha_check check (racha >= 0)
);

create index alertas_asistencia_activas_idx
  on public.alertas_asistencia (academia_id, detectada_at desc)
  where activa;
create index alertas_asistencia_jugador_idx
  on public.alertas_asistencia (jugador_id);
create index alertas_asistencia_revisada_por_idx
  on public.alertas_asistencia (revisada_por);

create table public.partido_preparaciones (
  id uuid primary key default gen_random_uuid(),
  academia_id uuid not null references public.academias(id) on delete cascade,
  partido_id uuid not null references public.partidos(id) on delete cascade,
  categoria_id uuid not null references public.categorias(id) on delete cascade,
  profesor_id uuid references public.usuarios(id) on delete set null,
  sistema_juego text not null default '',
  objetivo text not null default '',
  indicaciones text not null default '',
  hora_citacion time,
  estado text not null default 'Borrador',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint partido_preparaciones_partido_unique unique (partido_id),
  constraint partido_preparaciones_estado_check check (estado in ('Borrador', 'Lista'))
);

create index partido_preparaciones_academia_categoria_idx
  on public.partido_preparaciones (academia_id, categoria_id, updated_at desc);
create index partido_preparaciones_profesor_idx
  on public.partido_preparaciones (profesor_id);

create table public.partido_plan_jugadores (
  id uuid primary key default gen_random_uuid(),
  preparacion_id uuid not null references public.partido_preparaciones(id) on delete cascade,
  jugador_id uuid not null references public.jugadores(id) on delete cascade,
  rol text not null,
  posicion text not null default '',
  orden smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint partido_plan_jugadores_unique unique (preparacion_id, jugador_id),
  constraint partido_plan_jugadores_rol_check check (rol in ('Titular', 'Suplente')),
  constraint partido_plan_jugadores_orden_check check (orden between 0 and 99)
);

create index partido_plan_jugadores_jugador_idx
  on public.partido_plan_jugadores (jugador_id);

alter table public.entrenamiento_bitacoras enable row level security;
alter table public.alertas_asistencia enable row level security;
alter table public.partido_preparaciones enable row level security;
alter table public.partido_plan_jugadores enable row level security;

revoke all on table public.entrenamiento_bitacoras from anon, authenticated;
revoke all on table public.alertas_asistencia from anon, authenticated;
revoke all on table public.partido_preparaciones from anon, authenticated;
revoke all on table public.partido_plan_jugadores from anon, authenticated;

grant select, insert, update, delete on table public.entrenamiento_bitacoras to service_role;
grant select, insert, update, delete on table public.alertas_asistencia to service_role;
grant select, insert, update, delete on table public.partido_preparaciones to service_role;
grant select, insert, update, delete on table public.partido_plan_jugadores to service_role;

comment on table public.entrenamiento_bitacoras is 'Bitácora operativa de entrenamientos visible para dirección y el profesor asignado.';
comment on table public.alertas_asistencia is 'Estado persistente de alertas por ausencias consecutivas para revisión de dirección.';
comment on table public.partido_preparaciones is 'Plan técnico del partido preparado por el profesor de la categoría.';
comment on table public.partido_plan_jugadores is 'Titulares y suplentes incluidos en la preparación técnica de un partido.';
