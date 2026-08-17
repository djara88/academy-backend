alter table public.academias
  add column if not exists guardian_license_ends_at date;

create table if not exists public.solicitudes_inscripcion_deportiva (
  id uuid primary key default gen_random_uuid(),
  academia_id uuid not null references public.academias(id) on delete cascade,
  tutor_id uuid not null references public.tutores(id) on delete cascade,
  jugador_id uuid not null references public.jugadores(id) on delete cascade,
  sede_id uuid not null references public.sedes(id),
  rama_id uuid not null references public.ramas(id),
  categoria_id uuid references public.categorias(id),
  estado text not null default 'pendiente' check (estado in ('pendiente','aprobada','rechazada','cancelada')),
  mensaje text,
  monto_matricula numeric(12,2) check (monto_matricula is null or monto_matricula >= 0),
  abono_matricula numeric(12,2) check (abono_matricula is null or abono_matricula >= 0),
  monto_mensualidad numeric(12,2) check (monto_mensualidad is null or monto_mensualidad >= 0),
  inscripcion_id uuid references public.inscripciones_deportivas(id) on delete set null,
  resuelto_por uuid references public.usuarios(id) on delete set null,
  respuesta text,
  resuelto_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists solicitudes_inscripcion_pendiente_unique
  on public.solicitudes_inscripcion_deportiva(academia_id,jugador_id,rama_id)
  where estado='pendiente';
create index if not exists idx_solicitud_inscripcion_tutor on public.solicitudes_inscripcion_deportiva(tutor_id);
create index if not exists idx_solicitud_inscripcion_jugador on public.solicitudes_inscripcion_deportiva(jugador_id);
create index if not exists idx_solicitud_inscripcion_rama on public.solicitudes_inscripcion_deportiva(rama_id);
create index if not exists idx_solicitud_inscripcion_categoria on public.solicitudes_inscripcion_deportiva(categoria_id) where categoria_id is not null;
create index if not exists idx_solicitud_inscripcion_inscripcion on public.solicitudes_inscripcion_deportiva(inscripcion_id) where inscripcion_id is not null;
create index if not exists idx_solicitud_inscripcion_resuelto_por on public.solicitudes_inscripcion_deportiva(resuelto_por) where resuelto_por is not null;

alter table public.solicitudes_inscripcion_deportiva enable row level security;
revoke all on table public.solicitudes_inscripcion_deportiva from anon, authenticated;
