create table if not exists public.deportista_salud (
  id uuid primary key default gen_random_uuid(),
  academia_id uuid not null references public.academias(id) on delete cascade,
  jugador_id uuid not null references public.jugadores(id) on delete cascade,
  estado_disponibilidad text not null default 'Sin evaluar' check (estado_disponibilidad in ('Sin evaluar','Disponible','Disponible con restricción','En recuperación','No disponible')),
  restriccion text,
  grupo_sanguineo text,
  alergias text,
  medicamentos text,
  enfermedades_cronicas text,
  observaciones text,
  contacto_emergencia_nombre text,
  contacto_emergencia_telefono text,
  contacto_emergencia_parentesco text,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (academia_id, jugador_id)
);

create table if not exists public.deportista_lesiones (
  id uuid primary key default gen_random_uuid(),
  academia_id uuid not null references public.academias(id) on delete cascade,
  jugador_id uuid not null references public.jugadores(id) on delete cascade,
  rama_id uuid references public.ramas(id) on delete set null,
  tipo text not null,
  zona text,
  descripcion text,
  estado text not null default 'Activa' check (estado in ('Activa','Recuperación','Entrenamiento parcial','Entrenamiento completo','Cerrada')),
  fecha_inicio date not null default current_date,
  fecha_retorno_estimada date,
  fecha_cierre date,
  restriccion text,
  observaciones text,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.deportista_certificados_salud (
  id uuid primary key default gen_random_uuid(),
  academia_id uuid not null references public.academias(id) on delete cascade,
  jugador_id uuid not null references public.jugadores(id) on delete cascade,
  tipo text not null default 'Certificado médico',
  fecha_emision date,
  fecha_vencimiento date,
  archivo_url text,
  observaciones text,
  activo boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.deportista_disponibilidad_historial (
  id uuid primary key default gen_random_uuid(),
  academia_id uuid not null references public.academias(id) on delete cascade,
  jugador_id uuid not null references public.jugadores(id) on delete cascade,
  estado text not null check (estado in ('Sin evaluar','Disponible','Disponible con restricción','En recuperación','No disponible')),
  motivo text,
  observaciones text,
  fecha_desde timestamptz not null default now(),
  fecha_hasta timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_deportista_salud_academia_estado on public.deportista_salud(academia_id, estado_disponibilidad);
create index if not exists idx_deportista_lesiones_jugador_estado on public.deportista_lesiones(academia_id, jugador_id, estado);
create index if not exists idx_deportista_lesiones_retorno on public.deportista_lesiones(academia_id, fecha_retorno_estimada) where estado <> 'Cerrada';
create index if not exists idx_deportista_certificados_vencimiento on public.deportista_certificados_salud(academia_id, fecha_vencimiento) where activo = true;
create index if not exists idx_deportista_disponibilidad_jugador_fecha on public.deportista_disponibilidad_historial(academia_id, jugador_id, fecha_desde desc);

alter table public.deportista_salud enable row level security;
alter table public.deportista_lesiones enable row level security;
alter table public.deportista_certificados_salud enable row level security;
alter table public.deportista_disponibilidad_historial enable row level security;
revoke all on public.deportista_salud from anon, authenticated;
revoke all on public.deportista_lesiones from anon, authenticated;
revoke all on public.deportista_certificados_salud from anon, authenticated;
revoke all on public.deportista_disponibilidad_historial from anon, authenticated;

insert into public.deportista_salud (
  academia_id,jugador_id,estado_disponibilidad,grupo_sanguineo,alergias,medicamentos,enfermedades_cronicas,observaciones,
  contacto_emergencia_nombre,contacto_emergencia_telefono,contacto_emergencia_parentesco
)
select
  j.academia_id,j.id,'Sin evaluar',j.grupo_sanguineo,j.alergias,j.medicamentos,j.enfermedades_cronicas,j.observaciones_medicas,
  coalesce(j.contacto_emergencia_nombre,j.contacto_emergencia),coalesce(j.contacto_emergencia_telefono,j.telefono_emergencia),j.contacto_emergencia_parentesco
from public.jugadores j
where j.academia_id is not null
on conflict (academia_id,jugador_id) do nothing;
