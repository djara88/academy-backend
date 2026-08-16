alter table public.partidos
  add column if not exists disciplina_codigo text;

alter table public.partido_estadisticas
  add column if not exists disciplina_codigo text,
  add column if not exists metricas_competitivas jsonb not null default '{}'::jsonb,
  add column if not exists metricas_version smallint not null default 1;

create index if not exists partido_estadisticas_disciplina_idx
  on public.partido_estadisticas (jugador_id, disciplina_codigo, created_at desc);

update public.partidos p
set disciplina_codigo = case
  when lower(r.disciplina) in ('fútbol','futbol','football') then 'futbol'
  when lower(r.disciplina) = 'futsal' then 'futsal'
  when lower(r.disciplina) in ('básquetbol','basquetbol','basketbol','basketball','basquet') then 'basquetbol'
  when lower(r.disciplina) in ('vóleibol','voleibol','volley','volleyball') then 'voleibol'
  when lower(r.disciplina) in ('tenis','tennis') then 'tenis'
  when lower(r.disciplina) in ('pádel','padel') then 'padel'
  when lower(r.disciplina) = 'hockey' then 'hockey'
  when lower(r.disciplina) = 'atletismo' then 'atletismo'
  when lower(r.disciplina) in ('natación','natacion') then 'natacion'
  when lower(r.disciplina) = 'gimnasia' then 'gimnasia'
  when lower(r.disciplina) in ('artes marciales','arte marcial','artes_marciales') then 'artes_marciales'
  when lower(r.disciplina) = 'rugby' then 'rugby'
  else 'generico'
end
from public.ramas r
where p.rama_id = r.id
  and p.disciplina_codigo is null;

update public.partidos p
set disciplina_codigo = case
  when lower(r.disciplina) in ('fútbol','futbol','football') then 'futbol'
  when lower(r.disciplina) = 'futsal' then 'futsal'
  when lower(r.disciplina) in ('básquetbol','basquetbol','basketbol','basketball','basquet') then 'basquetbol'
  when lower(r.disciplina) in ('vóleibol','voleibol','volley','volleyball') then 'voleibol'
  when lower(r.disciplina) in ('tenis','tennis') then 'tenis'
  when lower(r.disciplina) in ('pádel','padel') then 'padel'
  when lower(r.disciplina) = 'hockey' then 'hockey'
  when lower(r.disciplina) = 'atletismo' then 'atletismo'
  when lower(r.disciplina) in ('natación','natacion') then 'natacion'
  when lower(r.disciplina) = 'gimnasia' then 'gimnasia'
  when lower(r.disciplina) in ('artes marciales','arte marcial','artes_marciales') then 'artes_marciales'
  when lower(r.disciplina) = 'rugby' then 'rugby'
  else 'generico'
end,
    rama_id = coalesce(p.rama_id, c.rama_id),
    sede_id = coalesce(p.sede_id, c.sede_id)
from public.categorias c
join public.ramas r on r.id = c.rama_id
where p.categoria_id = c.id
  and p.disciplina_codigo is null;

update public.partido_estadisticas pe
set disciplina_codigo = p.disciplina_codigo,
    metricas_competitivas = case
      when p.disciplina_codigo in ('futbol','futsal') then jsonb_build_object(
        'goles', coalesce(pe.goles, 0),
        'asistencias', coalesce(pe.asistencias, 0),
        'tarjetas_amarillas', coalesce(pe.tarjetas_amarillas, 0),
        'tarjetas_rojas', coalesce(pe.tarjetas_rojas, 0)
      )
      else coalesce(pe.metricas_competitivas, '{}'::jsonb)
    end
from public.partidos p
where pe.partido_id = p.id
  and pe.disciplina_codigo is null;
