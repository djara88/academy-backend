-- Perfil multirrama del alumno.
-- Cambios aditivos: no elimina ni transforma datos existentes.

alter table public.inscripciones_deportivas
  add column if not exists rol_especialidad text;

alter table public.ramas
  add column if not exists config_reconocimientos jsonb not null default '{}'::jsonb;

comment on column public.inscripciones_deportivas.rol_especialidad is
  'Rol, posición o especialidad específica del alumno dentro de esta inscripción/rama.';

comment on column public.ramas.config_reconocimientos is
  'Reconocimientos personalizados definidos por la academia para esta rama; los estándares de Syncademia se resuelven por disciplina.';
