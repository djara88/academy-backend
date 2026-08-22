-- Horarios múltiples por sede.
-- Se conserva dias_entrenamiento/horarios_entrenamiento como proyección legacy.

alter table public.sedes
  add column if not exists horarios_config jsonb not null default '[]'::jsonb;

alter table public.sedes
  drop constraint if exists sedes_horarios_config_array_check;

alter table public.sedes
  add constraint sedes_horarios_config_array_check
  check (jsonb_typeof(horarios_config) = 'array');

comment on column public.sedes.horarios_config is
  'Lista de bloques de entrenamiento [{dias, inicio, fin}]. Los campos dias_entrenamiento y horarios_entrenamiento se mantienen como resumen legacy.';
