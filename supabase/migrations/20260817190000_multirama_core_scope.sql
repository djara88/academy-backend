-- Núcleo multirrama para módulos operativos.
-- Todos los cambios son aditivos; valores NULL conservan el significado histórico/global.

alter table public.academias
  add column if not exists rama_principal_id uuid;

alter table public.prendas_catalogo
  add column if not exists sede_id uuid,
  add column if not exists rama_id uuid;

alter table public.pedidos_indumentaria
  add column if not exists inscripcion_id uuid;

alter table public.torneo_participantes
  add column if not exists sede_id uuid,
  add column if not exists rama_id uuid,
  add column if not exists categoria_id uuid,
  add column if not exists inscripcion_id uuid;

alter table public.egresos
  add column if not exists sede_id uuid,
  add column if not exists rama_id uuid;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'academias_rama_principal_id_fkey') then
    alter table public.academias add constraint academias_rama_principal_id_fkey
      foreign key (rama_principal_id) references public.ramas(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'prendas_catalogo_sede_id_fkey') then
    alter table public.prendas_catalogo add constraint prendas_catalogo_sede_id_fkey
      foreign key (sede_id) references public.sedes(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'prendas_catalogo_rama_id_fkey') then
    alter table public.prendas_catalogo add constraint prendas_catalogo_rama_id_fkey
      foreign key (rama_id) references public.ramas(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pedidos_indumentaria_inscripcion_id_fkey') then
    alter table public.pedidos_indumentaria add constraint pedidos_indumentaria_inscripcion_id_fkey
      foreign key (inscripcion_id) references public.inscripciones_deportivas(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'torneo_participantes_sede_id_fkey') then
    alter table public.torneo_participantes add constraint torneo_participantes_sede_id_fkey
      foreign key (sede_id) references public.sedes(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'torneo_participantes_rama_id_fkey') then
    alter table public.torneo_participantes add constraint torneo_participantes_rama_id_fkey
      foreign key (rama_id) references public.ramas(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'torneo_participantes_categoria_id_fkey') then
    alter table public.torneo_participantes add constraint torneo_participantes_categoria_id_fkey
      foreign key (categoria_id) references public.categorias(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'torneo_participantes_inscripcion_id_fkey') then
    alter table public.torneo_participantes add constraint torneo_participantes_inscripcion_id_fkey
      foreign key (inscripcion_id) references public.inscripciones_deportivas(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'egresos_sede_id_fkey') then
    alter table public.egresos add constraint egresos_sede_id_fkey
      foreign key (sede_id) references public.sedes(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'egresos_rama_id_fkey') then
    alter table public.egresos add constraint egresos_rama_id_fkey
      foreign key (rama_id) references public.ramas(id) on delete set null;
  end if;
end $$;

create index if not exists idx_prendas_catalogo_academia_rama on public.prendas_catalogo(academia_id, rama_id);
create index if not exists idx_pedidos_indumentaria_academia_rama on public.pedidos_indumentaria(academia_id, rama_id);
create index if not exists idx_torneos_academia_rama on public.torneos(academia_id, rama_id);
create index if not exists idx_torneo_participantes_rama_categoria on public.torneo_participantes(rama_id, categoria_id);
create index if not exists idx_egresos_academia_rama on public.egresos(academia_id, rama_id);
create index if not exists idx_entrenamientos_academia_rama on public.entrenamientos(academia_id, rama_id);
create index if not exists idx_partidos_academia_rama on public.partidos(academia_id, rama_id);

comment on column public.academias.rama_principal_id is 'Rama deportiva principal elegida por la academia para onboarding y valores por defecto.';
comment on column public.prendas_catalogo.rama_id is 'NULL = prenda transversal a toda la academia; valor = prenda específica de la rama.';
comment on column public.pedidos_indumentaria.inscripcion_id is 'Inscripción deportiva que originó o contextualiza el pedido.';
comment on column public.torneo_participantes.inscripcion_id is 'Inscripción deportiva activa usada para convocar al alumno al torneo.';
comment on column public.egresos.rama_id is 'Rama/coste deportivo al que corresponde el egreso; NULL = gasto general.';
