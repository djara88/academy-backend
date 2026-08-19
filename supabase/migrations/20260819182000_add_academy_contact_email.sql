alter table public.academias
  add column if not exists correo_academia character varying;

update public.academias
set correo_academia = director_email
where (correo_academia is null or btrim(correo_academia) = '')
  and director_email is not null
  and btrim(director_email) <> '';

comment on column public.academias.correo_academia is
  'Correo institucional o de contacto general de la academia; puede ser distinto del correo del director.';
