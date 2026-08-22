-- Evita categorías duplicadas dentro de una misma rama deportiva.
-- La comparación ignora mayúsculas/minúsculas y espacios exteriores.
create unique index if not exists categorias_academia_rama_nombre_normalizado_uidx
on public.categorias (academia_id, rama_id, lower(btrim(nombre)))
where rama_id is not null;
