-- Etiqueta únicamente el esquema histórico de fútbol conocido.
-- No transforma puntajes ni nombres de métricas: conserva el radar original
-- como perfil legacy v1 para impedir comparaciones falsas con perfiles v2.

update public.evaluaciones e
set
  disciplina_codigo = 'futbol',
  perfil_evaluacion = 'futbol:legacy',
  metricas_version = 1
from public.ramas r
where e.rama_id = r.id
  and e.disciplina_codigo is null
  and lower(r.disciplina) in ('fútbol', 'futbol')
  and jsonb_typeof(e.datos_radar) = 'object'
  and (select count(*) from jsonb_object_keys(e.datos_radar)) = 6
  and e.datos_radar ?& array['Defensa','Físico','Mental','Pase','Remate','Velocidad'];
