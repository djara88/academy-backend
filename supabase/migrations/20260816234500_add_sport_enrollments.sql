create table if not exists public.inscripciones_deportivas (
  id uuid primary key default uuid_generate_v4(),
  academia_id uuid not null references public.academias(id) on delete cascade,
  jugador_id uuid not null references public.jugadores(id) on delete cascade,
  sede_id uuid not null references public.sedes(id),
  rama_id uuid not null references public.ramas(id),
  categoria_id uuid references public.categorias(id),
  estado text not null default 'Activa' check (estado in ('Activa','Inactiva','Retirada')),
  fecha_inicio date not null default current_date,
  fecha_fin date,
  monto_matricula numeric(12,2) not null default 0 check (monto_matricula >= 0),
  monto_mensualidad numeric(12,2) not null default 0 check (monto_mensualidad >= 0),
  es_principal boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists inscripciones_deportivas_activa_unique
  on public.inscripciones_deportivas(academia_id,jugador_id,rama_id)
  where estado='Activa';
create index if not exists idx_inscripciones_academia_jugador
  on public.inscripciones_deportivas(academia_id,jugador_id);
create index if not exists idx_inscripciones_rama_categoria
  on public.inscripciones_deportivas(rama_id,categoria_id);

alter table public.inscripciones_deportivas enable row level security;
revoke all on table public.inscripciones_deportivas from anon, authenticated;

alter table public.cobros add column if not exists inscripcion_id uuid references public.inscripciones_deportivas(id) on delete set null;
create index if not exists idx_cobros_inscripcion on public.cobros(inscripcion_id);

insert into public.inscripciones_deportivas (
  academia_id,jugador_id,sede_id,rama_id,categoria_id,estado,fecha_inicio,monto_matricula,monto_mensualidad,es_principal
)
select
  j.academia_id,j.id,j.sede_id,j.rama_id,
  coalesce((select jc.categoria_id from public.jugador_categoria jc join public.categorias c on c.id=jc.categoria_id where jc.jugador_id=j.id and c.rama_id=j.rama_id order by jc.created_at asc limit 1),j.categoria_id),
  case when lower(coalesce(j.estado_matricula,'')) in ('inactiva','retirado','retirada','baja') then 'Inactiva' else 'Activa' end,
  coalesce(j.fecha_matricula,j.created_at::date,current_date),
  greatest(coalesce(j.monto_matricula,j.valor_matricula,0),0),
  greatest(coalesce(j.monto_mensualidad,j.valor_mensualidad,0),0),
  true
from public.jugadores j
where j.academia_id is not null and j.sede_id is not null and j.rama_id is not null
on conflict do nothing;

update public.cobros c
set inscripcion_id=i.id,sede_id=coalesce(c.sede_id,i.sede_id),rama_id=coalesce(c.rama_id,i.rama_id)
from public.inscripciones_deportivas i
where c.inscripcion_id is null and c.academia_id=i.academia_id and c.jugador_id=i.jugador_id and i.es_principal=true;

drop index if exists public.cobros_matricula_jugador_unique;
drop index if exists public.cobros_mensualidad_periodo_unique;

create unique index if not exists cobros_matricula_inscripcion_unique
  on public.cobros(academia_id,jugador_id,coalesce(inscripcion_id,'00000000-0000-0000-0000-000000000000'::uuid))
  where tipo_concepto='Matrícula' and jugador_id is not null and estado<>'Anulado';

create unique index if not exists cobros_mensualidad_inscripcion_periodo_unique
  on public.cobros(academia_id,jugador_id,coalesce(inscripcion_id,'00000000-0000-0000-0000-000000000000'::uuid),periodo_mensualidad)
  where tipo_concepto='Mensualidad' and periodo_mensualidad is not null and estado<>'Anulado';
