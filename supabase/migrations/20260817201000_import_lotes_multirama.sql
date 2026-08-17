alter table public.import_lotes
  add column if not exists sede_id uuid,
  add column if not exists rama_id uuid;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'import_lotes_sede_id_fkey') then
    alter table public.import_lotes add constraint import_lotes_sede_id_fkey
      foreign key (sede_id) references public.sedes(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'import_lotes_rama_id_fkey') then
    alter table public.import_lotes add constraint import_lotes_rama_id_fkey
      foreign key (rama_id) references public.ramas(id) on delete set null;
  end if;
end $$;

create index if not exists idx_import_lotes_academia_rama on public.import_lotes(academia_id, rama_id, created_at desc);

comment on column public.import_lotes.rama_id is 'Rama deportiva destino elegida para la importación masiva.';
