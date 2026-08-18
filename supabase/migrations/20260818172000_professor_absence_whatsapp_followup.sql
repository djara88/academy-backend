alter table public.profesor_caso_mensajes
  drop constraint if exists profesor_caso_mensajes_autor_rol_check;

alter table public.profesor_caso_mensajes
  add constraint profesor_caso_mensajes_autor_rol_check
  check (autor_rol = any (array['profesor'::text,'director'::text,'apoderado'::text]));

create table if not exists public.asistencia_seguimientos_whatsapp (
  id uuid primary key default gen_random_uuid(),
  academia_id uuid not null references public.academias(id) on delete cascade,
  entrenamiento_id uuid not null references public.entrenamientos(id) on delete cascade,
  jugador_id uuid not null references public.jugadores(id) on delete cascade,
  tutor_id uuid references public.tutores(id) on delete set null,
  profesor_id uuid references public.usuarios(id) on delete set null,
  caso_id uuid references public.profesor_casos(id) on delete set null,
  telefono text not null,
  telefono_comparable text not null,
  estado text not null default 'pendiente' check (estado in ('pendiente','respondido','cancelado','fallido')),
  enviado_at timestamptz,
  respondido_at timestamptz,
  respuesta text,
  whatsapp_message_id text,
  error_envio text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entrenamiento_id, jugador_id)
);

create index if not exists asistencia_seguimientos_whatsapp_pending_phone_idx
  on public.asistencia_seguimientos_whatsapp (academia_id, telefono_comparable, estado, enviado_at desc);
create index if not exists asistencia_seguimientos_whatsapp_case_idx
  on public.asistencia_seguimientos_whatsapp (caso_id);

alter table public.asistencia_seguimientos_whatsapp enable row level security;
revoke all on table public.asistencia_seguimientos_whatsapp from anon, authenticated;
grant select, insert, update, delete on table public.asistencia_seguimientos_whatsapp to service_role;