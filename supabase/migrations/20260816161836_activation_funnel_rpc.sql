create or replace function public.obtener_embudo_activacion_syncademia(p_since timestamptz default (now() - interval '30 days'))
returns jsonb
language sql
security definer
set search_path = public
as $$
with cohort as (
  select a.id, a.nombre, a.created_at, a.subscription_status
  from public.academias a
  where a.created_at >= p_since
), milestones as (
  select
    a.id,
    a.nombre,
    a.created_at as registered_at,
    a.subscription_status,
    (select min(r.created_at) from public.ramas r where r.academia_id = a.id) as structure_at,
    (select min(j.created_at) from public.jugadores j where j.academia_id = a.id) as first_player_at,
    (select min(c.created_at) from public.cobros c where c.academia_id = a.id) as first_charge_at,
    (select min(asi.created_at)
       from public.asistencias asi
       join public.jugadores j2 on j2.id = asi.jugador_id
      where j2.academia_id = a.id) as first_attendance_at,
    (select min(e.created_at) from public.evaluaciones e where e.academia_id = a.id) as first_evaluation_at,
    (select min(pc.created_at) from public.plataforma_cobros pc where pc.academia_id = a.id) as checkout_at,
    (select min(pc.pagado_at) from public.plataforma_cobros pc where pc.academia_id = a.id and pc.estado = 'pagado') as paid_at
  from cohort a
), counts as (
  select
    count(*)::int as registered,
    count(*) filter (where structure_at is not null)::int as structured,
    count(*) filter (where first_player_at is not null)::int as enrolled,
    count(*) filter (where first_charge_at is not null)::int as financed,
    count(*) filter (where first_attendance_at is not null)::int as operating,
    count(*) filter (where checkout_at is not null)::int as checkout,
    count(*) filter (where paid_at is not null or subscription_status = 'active')::int as paid,
    count(*) filter (where first_evaluation_at is not null)::int as evaluated
  from milestones
), recent_academies as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'academyId', id,
    'academyName', nombre,
    'registeredAt', registered_at,
    'currentMilestone', case
      when paid_at is not null or subscription_status = 'active' then 'paid'
      when checkout_at is not null then 'checkout'
      when first_attendance_at is not null then 'operating'
      when first_charge_at is not null then 'financed'
      when first_player_at is not null then 'enrolled'
      when structure_at is not null then 'structured'
      else 'registered'
    end,
    'lastMilestoneAt', greatest(
      registered_at,
      coalesce(structure_at, registered_at),
      coalesce(first_player_at, registered_at),
      coalesce(first_charge_at, registered_at),
      coalesce(first_attendance_at, registered_at),
      coalesce(first_evaluation_at, registered_at),
      coalesce(checkout_at, registered_at),
      coalesce(paid_at, registered_at)
    )
  ) order by registered_at desc), '[]'::jsonb) as items
  from milestones
)
select jsonb_build_object(
  'since', p_since,
  'cohort', c.registered,
  'stages', jsonb_build_array(
    jsonb_build_object('code','registered','label','Registro','count',c.registered,'rate',case when c.registered=0 then 0 else 100 end),
    jsonb_build_object('code','structured','label','Estructura','count',c.structured,'rate',case when c.registered=0 then 0 else round(c.structured::numeric * 100 / c.registered) end),
    jsonb_build_object('code','enrolled','label','Primer deportista','count',c.enrolled,'rate',case when c.registered=0 then 0 else round(c.enrolled::numeric * 100 / c.registered) end),
    jsonb_build_object('code','financed','label','Primer cobro','count',c.financed,'rate',case when c.registered=0 then 0 else round(c.financed::numeric * 100 / c.registered) end),
    jsonb_build_object('code','operating','label','Primera asistencia','count',c.operating,'rate',case when c.registered=0 then 0 else round(c.operating::numeric * 100 / c.registered) end),
    jsonb_build_object('code','checkout','label','Checkout','count',c.checkout,'rate',case when c.registered=0 then 0 else round(c.checkout::numeric * 100 / c.registered) end),
    jsonb_build_object('code','paid','label','Suscripción activa','count',c.paid,'rate',case when c.registered=0 then 0 else round(c.paid::numeric * 100 / c.registered) end)
  ),
  'productDepth', jsonb_build_object(
    'evaluated', c.evaluated,
    'evaluationRate', case when c.registered=0 then 0 else round(c.evaluated::numeric * 100 / c.registered) end
  ),
  'academies', r.items
)
from counts c cross join recent_academies r;
$$;

revoke all on function public.obtener_embudo_activacion_syncademia(timestamptz) from public;
revoke all on function public.obtener_embudo_activacion_syncademia(timestamptz) from anon;
revoke all on function public.obtener_embudo_activacion_syncademia(timestamptz) from authenticated;
grant execute on function public.obtener_embudo_activacion_syncademia(timestamptz) to service_role;
