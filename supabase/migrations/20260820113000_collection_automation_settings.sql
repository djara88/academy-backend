alter table public.configuracion_financiera
  add column if not exists cobranza_automatica boolean not null default false,
  add column if not exists cobranza_auto_email boolean not null default true,
  add column if not exists cobranza_auto_whatsapp boolean not null default true,
  add column if not exists cobranza_recordar_antes boolean not null default true,
  add column if not exists cobranza_recordar_vencido boolean not null default true,
  add column if not exists cobranza_dias_mora integer[] not null default array[1,5,10,15],
  add column if not exists cobranza_hora_local smallint not null default 9;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'configuracion_financiera_cobranza_hora_local_check'
      and conrelid = 'public.configuracion_financiera'::regclass
  ) then
    alter table public.configuracion_financiera
      add constraint configuracion_financiera_cobranza_hora_local_check
      check (cobranza_hora_local between 0 and 23);
  end if;
end $$;

alter table public.cobranza_notificaciones
  add column if not exists dedupe_key text;

create unique index if not exists cobranza_notificaciones_dedupe_idx
  on public.cobranza_notificaciones (academia_id, dedupe_key)
  where dedupe_key is not null;
