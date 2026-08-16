create or replace function public.obtener_dashboard_kpis(
  p_academia_id uuid,
  p_month_start date,
  p_next_month date,
  p_today date
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
select jsonb_build_object(
  'jugadores', (select count(*)::int from public.jugadores j where j.academia_id = p_academia_id),
  'profesores_activos', (select count(*)::int from public.usuarios u where u.academia_id = p_academia_id and u.rol = 'profesor' and u.activo = true),
  'categorias', (select count(*)::int from public.categorias c where c.academia_id = p_academia_id),
  'ingresos_mes', coalesce((select sum(p.monto) from public.pagos p where p.academia_id = p_academia_id and p.fecha_pago >= p_month_start::timestamptz and p.fecha_pago < p_next_month::timestamptz), 0),
  'egresos_mes', coalesce((select sum(e.monto) from public.egresos e where e.academia_id = p_academia_id and e.fecha_gasto >= p_month_start and e.fecha_gasto < p_next_month and e.anulado_at is null), 0),
  'por_cobrar', coalesce((select sum(greatest(coalesce(c.monto, 0) - coalesce(c.monto_pagado, 0), 0)) from public.cobros c where c.academia_id = p_academia_id and c.estado <> 'Anulado'), 0),
  'cobros_vencidos', (select count(*)::int from public.cobros c where c.academia_id = p_academia_id and c.estado <> 'Anulado' and c.fecha_vencimiento is not null and c.fecha_vencimiento < p_today and greatest(coalesce(c.monto, 0) - coalesce(c.monto_pagado, 0), 0) > 0),
  'uniformes_pendientes', (select count(*)::int from public.jugadores j where j.academia_id = p_academia_id and lower(coalesce(j.estado_uniforme, '')) not in ('entregado', 'completo')),
  'asistencia_mes', (
    select case
      when count(*) filter (where a.estado in ('Presente','Ausente','Justificado')) = 0 then null
      else round(100.0 * count(*) filter (where a.estado = 'Presente') / count(*) filter (where a.estado in ('Presente','Ausente','Justificado')))::int
    end
    from public.asistencias a
    join public.entrenamientos en on en.id = a.entrenamiento_id
    where en.academia_id = p_academia_id and en.fecha >= p_month_start and en.fecha < p_next_month
  ),
  'categorias_sin_profesor', coalesce((
    select jsonb_agg(jsonb_build_object('id', c.id, 'nombre', c.nombre) order by c.nombre)
    from public.categorias c
    where c.academia_id = p_academia_id
      and not exists (
        select 1 from public.profesor_categorias pc
        where pc.academia_id = p_academia_id and pc.categoria_id = c.id and pc.activo = true
      )
  ), '[]'::jsonb)
);
$$;

revoke all on function public.obtener_dashboard_kpis(uuid,date,date,date) from public;
revoke all on function public.obtener_dashboard_kpis(uuid,date,date,date) from anon;
revoke all on function public.obtener_dashboard_kpis(uuid,date,date,date) from authenticated;
grant execute on function public.obtener_dashboard_kpis(uuid,date,date,date) to service_role;
