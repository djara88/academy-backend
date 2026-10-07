alter table public.pedidos_indumentaria
  add column if not exists idempotency_key text;

create unique index if not exists pedidos_indumentaria_academia_idempotency_key_unique
  on public.pedidos_indumentaria (academia_id, idempotency_key)
  where idempotency_key is not null;

create or replace function public.create_uniform_order_v1(
  p_academia_id uuid,
  p_usuario_id uuid,
  p_jugador_id uuid,
  p_inscripcion_id uuid,
  p_sede_id uuid,
  p_rama_id uuid,
  p_prenda_id uuid default null,
  p_prenda_nombre text default null,
  p_talla text default null,
  p_numero_estampado integer default null,
  p_nombre_estampado text default null,
  p_monto numeric default 0,
  p_generar_cobro boolean default false,
  p_estado_pago text default 'Pendiente de Pago',
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_key text := nullif(left(btrim(coalesce(p_idempotency_key, '')), 160), '');
  v_order public.pedidos_indumentaria%rowtype;
  v_enrollment public.inscripciones_deportivas%rowtype;
  v_garment public.prendas_catalogo%rowtype;
  v_charge_id uuid := null;
  v_amount numeric := greatest(coalesce(p_monto, 0), 0);
  v_name text := nullif(btrim(coalesce(p_prenda_nombre, '')), '');
  v_size text := coalesce(nullif(btrim(coalesce(p_talla, '')), ''), 'S/T');
  v_payment_status text := coalesce(nullif(btrim(coalesce(p_estado_pago, '')), ''), 'Pendiente de Pago');
begin
  if p_academia_id is null or p_jugador_id is null or p_inscripcion_id is null
     or p_sede_id is null or p_rama_id is null then
    raise exception 'UNIFORM_INVALID_SCOPE';
  end if;
  if v_key is null then raise exception 'UNIFORM_IDEMPOTENCY_KEY_REQUIRED'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_academia_id::text || ':uniform:' || v_key, 73191));

  select * into v_order
  from public.pedidos_indumentaria
  where academia_id = p_academia_id and idempotency_key = v_key
  limit 1;

  if found then
    return jsonb_build_object('order', to_jsonb(v_order), 'idempotent', true, 'charge_id', v_order.cobro_id);
  end if;

  select * into v_enrollment
  from public.inscripciones_deportivas
  where id = p_inscripcion_id
    and academia_id = p_academia_id
    and jugador_id = p_jugador_id
    and sede_id = p_sede_id
    and rama_id = p_rama_id
    and estado = 'Activa'
  for update;
  if not found then raise exception 'UNIFORM_ENROLLMENT_SCOPE_MISMATCH'; end if;

  if p_prenda_id is not null then
    select * into v_garment
    from public.prendas_catalogo
    where id = p_prenda_id and academia_id = p_academia_id
    for update;
    if not found then raise exception 'UNIFORM_GARMENT_NOT_FOUND'; end if;
    if v_garment.rama_id is not null and v_garment.rama_id <> p_rama_id then
      raise exception 'UNIFORM_GARMENT_BRANCH_MISMATCH';
    end if;
    if v_name is null then v_name := v_garment.nombre; end if;
    if v_garment.tipo_operacion = 'Stock' and coalesce(v_garment.stock_disponible, 0) <= 0 then
      raise exception 'UNIFORM_OUT_OF_STOCK';
    end if;
  end if;

  if v_name is null then raise exception 'UNIFORM_NAME_REQUIRED'; end if;

  if p_generar_cobro = true and v_amount > 0 and v_payment_status <> 'Pagado' then
    insert into public.cobros (
      academia_id,jugador_id,inscripcion_id,sede_id,rama_id,concepto,tipo_concepto,
      monto,monto_pagado,estado,fecha_vencimiento,idempotency_key,observaciones
    ) values (
      p_academia_id,p_jugador_id,p_inscripcion_id,p_sede_id,p_rama_id,
      'Indumentaria · ' || v_name || ' (Talla ' || v_size || ')',
      'Indumentaria',v_amount,0,'Pendiente',(timezone('America/Santiago', now()))::date,
      'uniform-order:' || v_key || ':charge',
      case when p_usuario_id is not null then 'Creado por pedido de uniforme' else null end
    ) returning id into v_charge_id;
  end if;

  insert into public.pedidos_indumentaria (
    academia_id,jugador_id,inscripcion_id,sede_id,rama_id,prenda_id,prenda_nombre,talla,
    numero_estampado,nombre_estampado,monto,cobro_id,estado_pago,estado_entrega,idempotency_key
  ) values (
    p_academia_id,p_jugador_id,p_inscripcion_id,p_sede_id,p_rama_id,p_prenda_id,v_name,v_size,
    p_numero_estampado,nullif(btrim(coalesce(p_nombre_estampado, '')), ''),
    v_amount,v_charge_id,v_payment_status,'Pendiente',v_key
  ) returning * into v_order;

  if p_prenda_id is not null and v_garment.tipo_operacion = 'Stock' then
    update public.prendas_catalogo
    set stock_disponible = stock_disponible - 1
    where id = p_prenda_id and academia_id = p_academia_id and stock_disponible > 0;
    if not found then raise exception 'UNIFORM_OUT_OF_STOCK'; end if;
  end if;

  return jsonb_build_object('order', to_jsonb(v_order), 'idempotent', false, 'charge_id', v_charge_id);
end;
$function$;

revoke execute on function public.create_uniform_order_v1(
  uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,integer,text,numeric,boolean,text,text
) from public, anon, authenticated;

grant execute on function public.create_uniform_order_v1(
  uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,integer,text,numeric,boolean,text,text
) to service_role;
