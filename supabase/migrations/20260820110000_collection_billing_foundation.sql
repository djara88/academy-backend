-- Lestra Deportivo - Cobranza 2.0 foundation
-- Real installment schedules, payment allocation, reported-payment review,
-- secure public collection tokens and notification audit.

create table if not exists public.cobro_cuotas (
  id uuid primary key default gen_random_uuid(),
  academia_id uuid not null references public.academias(id) on delete cascade,
  cobro_id uuid not null references public.cobros(id) on delete cascade,
  numero integer not null check (numero >= 1),
  total_cuotas integer not null check (total_cuotas >= 1 and numero <= total_cuotas),
  monto numeric(12,2) not null check (monto > 0),
  monto_pagado numeric(12,2) not null default 0 check (monto_pagado >= 0 and monto_pagado <= monto),
  fecha_vencimiento date not null,
  estado text not null default 'Pendiente' check (estado in ('Pendiente','Parcial','Pagada','Anulada')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cobro_id, numero)
);

create table if not exists public.pago_cuota_aplicaciones (
  id uuid primary key default gen_random_uuid(),
  academia_id uuid not null references public.academias(id) on delete cascade,
  pago_id uuid not null references public.pagos(id) on delete cascade,
  cuota_id uuid not null references public.cobro_cuotas(id) on delete cascade,
  monto numeric(12,2) not null check (monto > 0),
  created_at timestamptz not null default now(),
  unique (pago_id, cuota_id)
);

create table if not exists public.pagos_informados (
  id uuid primary key default gen_random_uuid(),
  academia_id uuid not null references public.academias(id) on delete cascade,
  cobro_id uuid not null references public.cobros(id) on delete cascade,
  cuota_id uuid references public.cobro_cuotas(id) on delete set null,
  jugador_id uuid references public.jugadores(id) on delete set null,
  tutor_id uuid references public.tutores(id) on delete set null,
  monto numeric(12,2) not null check (monto > 0),
  metodo_pago text not null default 'Transferencia',
  fecha_pago_informada date not null default current_date,
  comprobante_ref text,
  observaciones text,
  estado text not null default 'Pendiente' check (estado in ('Pendiente','Validado','Rechazado')),
  canal text not null default 'portal' check (canal in ('portal','portal_apoderado','direccion')),
  idempotency_key text,
  created_at timestamptz not null default now(),
  revisado_at timestamptz,
  revisado_por uuid,
  motivo_rechazo text,
  unique (academia_id, idempotency_key)
);

create table if not exists public.cobranza_portal_tokens (
  id uuid primary key default gen_random_uuid(),
  academia_id uuid not null references public.academias(id) on delete cascade,
  tutor_id uuid references public.tutores(id) on delete cascade,
  jugador_id uuid references public.jugadores(id) on delete cascade,
  token_hash text not null unique,
  alcance text not null default 'estado_cuenta' check (alcance in ('estado_cuenta','pago_informado')),
  expira_at timestamptz not null,
  ultimo_uso_at timestamptz,
  revocado_at timestamptz,
  creado_via text not null default 'sistema',
  creado_por uuid,
  created_at timestamptz not null default now(),
  check (tutor_id is not null or jugador_id is not null)
);

create table if not exists public.cobranza_verificaciones (
  id uuid primary key default gen_random_uuid(),
  academia_id uuid not null references public.academias(id) on delete cascade,
  tutor_id uuid references public.tutores(id) on delete cascade,
  jugador_id uuid references public.jugadores(id) on delete cascade,
  rut_hash text not null,
  codigo_hash text not null,
  canal text not null check (canal in ('email','whatsapp')),
  destino_enmascarado text not null,
  expira_at timestamptz not null,
  intentos integer not null default 0 check (intentos >= 0),
  verificado_at timestamptz,
  created_at timestamptz not null default now(),
  check (tutor_id is not null or jugador_id is not null)
);

create table if not exists public.cobranza_notificaciones (
  id uuid primary key default gen_random_uuid(),
  academia_id uuid not null references public.academias(id) on delete cascade,
  tutor_id uuid references public.tutores(id) on delete set null,
  jugador_id uuid references public.jugadores(id) on delete set null,
  token_id uuid references public.cobranza_portal_tokens(id) on delete set null,
  canal text not null check (canal in ('email','whatsapp')),
  tipo text not null default 'estado_cuenta' check (tipo in ('estado_cuenta','recordatorio','vencimiento')),
  estado text not null default 'Pendiente' check (estado in ('Pendiente','Enviado','Error')),
  enviado_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.cobro_cuotas enable row level security;
alter table public.pago_cuota_aplicaciones enable row level security;
alter table public.pagos_informados enable row level security;
alter table public.cobranza_portal_tokens enable row level security;
alter table public.cobranza_verificaciones enable row level security;
alter table public.cobranza_notificaciones enable row level security;

revoke all on public.cobro_cuotas from public, anon, authenticated;
revoke all on public.pago_cuota_aplicaciones from public, anon, authenticated;
revoke all on public.pagos_informados from public, anon, authenticated;
revoke all on public.cobranza_portal_tokens from public, anon, authenticated;
revoke all on public.cobranza_verificaciones from public, anon, authenticated;
revoke all on public.cobranza_notificaciones from public, anon, authenticated;

grant all on public.cobro_cuotas to service_role;
grant all on public.pago_cuota_aplicaciones to service_role;
grant all on public.pagos_informados to service_role;
grant all on public.cobranza_portal_tokens to service_role;
grant all on public.cobranza_verificaciones to service_role;
grant all on public.cobranza_notificaciones to service_role;

create index if not exists cobro_cuotas_academia_vencimiento_idx on public.cobro_cuotas (academia_id, fecha_vencimiento, estado);
create index if not exists cobro_cuotas_cobro_idx on public.cobro_cuotas (cobro_id, numero);
create index if not exists pago_cuota_aplicaciones_cuota_idx on public.pago_cuota_aplicaciones (cuota_id, created_at);
create index if not exists pagos_informados_academia_estado_idx on public.pagos_informados (academia_id, estado, created_at desc);
create index if not exists pagos_informados_cobro_idx on public.pagos_informados (cobro_id, created_at desc);
create index if not exists cobranza_tokens_academia_expira_idx on public.cobranza_portal_tokens (academia_id, expira_at) where revocado_at is null;
create index if not exists cobranza_verificaciones_academia_created_idx on public.cobranza_verificaciones (academia_id, created_at desc);
create index if not exists cobranza_notificaciones_academia_created_idx on public.cobranza_notificaciones (academia_id, created_at desc);

create or replace function private.sync_cobro_child_academia()
returns trigger language plpgsql set search_path = 'public', 'pg_temp'
as $$
declare v_academia uuid;
begin
  select c.academia_id into v_academia from public.cobros c where c.id = new.cobro_id;
  if v_academia is null then raise exception 'Cobro no encontrado'; end if;
  new.academia_id := v_academia;
  return new;
end;$$;

create or replace function private.sync_payment_allocation_academia()
returns trigger language plpgsql set search_path = 'public', 'pg_temp'
as $$
declare v_pago_academia uuid; v_cuota_academia uuid;
begin
  select p.academia_id into v_pago_academia from public.pagos p where p.id = new.pago_id;
  select q.academia_id into v_cuota_academia from public.cobro_cuotas q where q.id = new.cuota_id;
  if v_pago_academia is null or v_cuota_academia is null or v_pago_academia <> v_cuota_academia then
    raise exception 'Pago y cuota no pertenecen a la misma academia';
  end if;
  new.academia_id := v_pago_academia;
  return new;
end;$$;

drop trigger if exists trg_cobro_cuotas_academia on public.cobro_cuotas;
create trigger trg_cobro_cuotas_academia before insert or update of cobro_id on public.cobro_cuotas
for each row execute function private.sync_cobro_child_academia();

drop trigger if exists trg_pagos_informados_academia on public.pagos_informados;
create trigger trg_pagos_informados_academia before insert or update of cobro_id on public.pagos_informados
for each row execute function private.sync_cobro_child_academia();

drop trigger if exists trg_pago_cuota_aplicaciones_academia on public.pago_cuota_aplicaciones;
create trigger trg_pago_cuota_aplicaciones_academia before insert or update of pago_id, cuota_id on public.pago_cuota_aplicaciones
for each row execute function private.sync_payment_allocation_academia();

create or replace function public.generar_cuotas_cobro(
  p_academia_id uuid,p_cobro_id uuid,p_total_cuotas integer,
  p_fecha_primera date default current_date,p_fecha_final date default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_cobro public.cobros%rowtype; v_existentes integer; v_pagadas numeric(12,2); v_total integer;
  v_primera date; v_final date; v_fecha date; v_span integer; v_base_centavos bigint; v_total_centavos bigint;
  v_monto numeric(12,2); v_restante_pagado numeric(12,2); v_aplicar numeric(12,2); i integer;
begin
  if p_total_cuotas is null or p_total_cuotas < 1 or p_total_cuotas > 24 then raise exception 'La cantidad de cuotas debe estar entre 1 y 24'; end if;
  select * into v_cobro from public.cobros where id=p_cobro_id and academia_id=p_academia_id for update;
  if not found then raise exception 'Cobro no encontrado para la academia'; end if;
  if v_cobro.estado='Anulado' then raise exception 'No se pueden generar cuotas para un cobro anulado'; end if;
  if coalesce(v_cobro.monto,0)<=0 then raise exception 'El cobro debe tener un monto mayor que cero'; end if;

  select count(*),coalesce(sum(monto_pagado),0) into v_existentes,v_pagadas from public.cobro_cuotas where cobro_id=p_cobro_id and estado<>'Anulada';
  if v_existentes>0 and v_pagadas>0 then
    select max(total_cuotas) into v_total from public.cobro_cuotas where cobro_id=p_cobro_id and estado<>'Anulada';
    if v_total<>p_total_cuotas then raise exception 'No se puede cambiar el número de cuotas porque el plan ya tiene pagos aplicados'; end if;
    return jsonb_build_object('cobro_id',p_cobro_id,'total_cuotas',v_total,'preservado',true);
  end if;

  delete from public.cobro_cuotas where cobro_id=p_cobro_id;
  v_final:=coalesce(p_fecha_final,v_cobro.fecha_vencimiento,p_fecha_primera,current_date);
  if p_total_cuotas=1 then v_primera:=v_final;
  else
    v_primera:=coalesce(p_fecha_primera,current_date);
    if v_primera>v_final then v_primera:=(v_final-((p_total_cuotas-1)*interval '1 month'))::date; end if;
  end if;
  v_total_centavos:=round(v_cobro.monto*100)::bigint;
  v_base_centavos:=floor(v_total_centavos::numeric/p_total_cuotas)::bigint;
  v_span:=greatest(v_final-v_primera,0);

  for i in 1..p_total_cuotas loop
    if i=p_total_cuotas then
      v_monto:=(v_total_centavos-v_base_centavos*(p_total_cuotas-1))::numeric/100; v_fecha:=v_final;
    else
      v_monto:=v_base_centavos::numeric/100;
      if p_total_cuotas=1 then v_fecha:=v_final;
      elsif v_span>0 then v_fecha:=v_primera+round((v_span::numeric*(i-1))/(p_total_cuotas-1))::integer;
      else v_fecha:=(v_primera+((i-1)*interval '1 month'))::date; end if;
    end if;
    insert into public.cobro_cuotas(academia_id,cobro_id,numero,total_cuotas,monto,monto_pagado,fecha_vencimiento,estado)
    values(p_academia_id,p_cobro_id,i,p_total_cuotas,v_monto,0,v_fecha,'Pendiente');
  end loop;

  v_restante_pagado:=least(coalesce(v_cobro.monto_pagado,0),coalesce(v_cobro.monto,0));
  if v_restante_pagado>0 then
    for i in 1..p_total_cuotas loop
      exit when v_restante_pagado<=0;
      select least(v_restante_pagado,monto-monto_pagado) into v_aplicar from public.cobro_cuotas where cobro_id=p_cobro_id and numero=i;
      if coalesce(v_aplicar,0)>0 then
        update public.cobro_cuotas set monto_pagado=monto_pagado+v_aplicar,
          estado=case when monto_pagado+v_aplicar>=monto then 'Pagada' else 'Parcial' end,updated_at=now()
        where cobro_id=p_cobro_id and numero=i;
        v_restante_pagado:=v_restante_pagado-v_aplicar;
      end if;
    end loop;
  end if;
  return jsonb_build_object('cobro_id',p_cobro_id,'total_cuotas',p_total_cuotas,'preservado',false);
end;$$;

revoke all on function public.generar_cuotas_cobro(uuid,uuid,integer,date,date) from public,anon,authenticated;
grant execute on function public.generar_cuotas_cobro(uuid,uuid,integer,date,date) to service_role;

create or replace function public.registrar_pago_cobro(
  p_academia_id uuid,p_cobro_id uuid,p_monto numeric,p_metodo_pago text,
  p_observaciones text default null,p_idempotency_key text default null,p_usuario_id uuid default null
) returns jsonb language plpgsql security definer set search_path=''
as $$
declare
  v_cobro public.cobros%rowtype; v_cobro_actualizado public.cobros%rowtype; v_pago public.pagos%rowtype;
  v_pagado numeric(12,2); v_saldo numeric(12,2); v_estado text; v_restante numeric(12,2); v_aplicar numeric(12,2); v_cuota record;
begin
  if p_monto is null or p_monto<=0 then raise exception 'El monto del pago debe ser mayor que cero'; end if;
  if p_idempotency_key is not null then
    select * into v_pago from public.pagos where academia_id=p_academia_id and idempotency_key=p_idempotency_key;
    if found then
      select * into v_cobro_actualizado from public.cobros where id=v_pago.cobro_id;
      return jsonb_build_object('pago',to_jsonb(v_pago),'cobro',to_jsonb(v_cobro_actualizado),'idempotente',true);
    end if;
  end if;
  select * into v_cobro from public.cobros where id=p_cobro_id and academia_id=p_academia_id for update;
  if not found then raise exception 'Cobro no encontrado para la academia'; end if;
  if v_cobro.estado='Anulado' then raise exception 'No se puede pagar un cobro anulado'; end if;
  v_saldo:=greatest(coalesce(v_cobro.monto,0)-coalesce(v_cobro.monto_pagado,0),0);
  if p_monto>v_saldo then raise exception 'El pago supera el saldo pendiente de %',v_saldo; end if;

  insert into public.pagos(academia_id,cobro_id,jugador_id,monto,metodo_pago,observaciones,idempotency_key,registrado_por)
  values(p_academia_id,p_cobro_id,v_cobro.jugador_id,p_monto,coalesce(nullif(trim(p_metodo_pago),''),'Sin registrar'),nullif(trim(p_observaciones),''),p_idempotency_key,p_usuario_id)
  returning * into v_pago;

  v_restante:=p_monto;
  for v_cuota in select * from public.cobro_cuotas where cobro_id=v_cobro.id and estado<>'Anulada' and monto_pagado<monto order by numero for update loop
    exit when v_restante<=0;
    v_aplicar:=least(v_restante,v_cuota.monto-v_cuota.monto_pagado);
    if v_aplicar>0 then
      update public.cobro_cuotas set monto_pagado=monto_pagado+v_aplicar,
        estado=case when monto_pagado+v_aplicar>=monto then 'Pagada' else 'Parcial' end,updated_at=now() where id=v_cuota.id;
      insert into public.pago_cuota_aplicaciones(academia_id,pago_id,cuota_id,monto)
      values(p_academia_id,v_pago.id,v_cuota.id,v_aplicar)
      on conflict(pago_id,cuota_id) do update set monto=public.pago_cuota_aplicaciones.monto+excluded.monto;
      v_restante:=v_restante-v_aplicar;
    end if;
  end loop;

  v_pagado:=coalesce(v_cobro.monto_pagado,0)+p_monto;
  v_estado:=case when v_pagado>=coalesce(v_cobro.monto,0) then 'Pagado' else 'Parcial' end;
  update public.cobros set monto_pagado=v_pagado,estado=v_estado,metodo_pago=v_pago.metodo_pago,fecha_pago=v_pago.fecha_pago,
    observaciones=case when v_pago.observaciones is null then cobros.observaciones else concat_ws(' | ',nullif(cobros.observaciones,''),v_pago.observaciones) end
  where id=v_cobro.id and academia_id=p_academia_id returning * into v_cobro_actualizado;

  if v_cobro.jugador_id is not null then
    update public.jugadores j set estado_financiero=case when exists(
      select 1 from public.cobros c where c.academia_id=p_academia_id and c.jugador_id=v_cobro.jugador_id
      and c.estado not in('Pagado','Anulado') and coalesce(c.monto,0)>coalesce(c.monto_pagado,0)
    ) then 'Moroso' else 'Al Día' end,ultimo_pago_fecha=v_pago.fecha_pago::date
    where j.id=v_cobro.jugador_id and j.academia_id=p_academia_id;
  end if;

  update public.pedidos_indumentaria set estado_pago=case when v_estado='Pagado' then 'Pagado' else 'Abonado' end
  where cobro_id=v_cobro.id and academia_id=p_academia_id;
  if v_cobro.torneo_id is not null and v_cobro.jugador_id is not null then
    update public.torneo_participantes set estado_pago=v_estado where torneo_id=v_cobro.torneo_id and jugador_id=v_cobro.jugador_id;
  end if;
  return jsonb_build_object('pago',to_jsonb(v_pago),'cobro',to_jsonb(v_cobro_actualizado),'idempotente',false);
end;$$;

revoke all on function public.registrar_pago_cobro(uuid,uuid,numeric,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.registrar_pago_cobro(uuid,uuid,numeric,text,text,text,uuid) to service_role;

create or replace function public.validar_pago_informado(p_academia_id uuid,p_pago_informado_id uuid,p_usuario_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_informado public.pagos_informados%rowtype; v_resultado jsonb;
begin
  select * into v_informado from public.pagos_informados where id=p_pago_informado_id and academia_id=p_academia_id for update;
  if not found then raise exception 'Pago informado no encontrado'; end if;
  if v_informado.estado='Validado' then return jsonb_build_object('id',v_informado.id,'estado','Validado','idempotente',true); end if;
  if v_informado.estado='Rechazado' then raise exception 'El pago informado ya fue rechazado'; end if;
  v_resultado:=public.registrar_pago_cobro(p_academia_id,v_informado.cobro_id,v_informado.monto,v_informado.metodo_pago,
    concat_ws(' | ','Pago informado validado',nullif(v_informado.observaciones,'')),'pago-informado-'||v_informado.id::text,p_usuario_id);
  update public.pagos_informados set estado='Validado',revisado_at=now(),revisado_por=p_usuario_id,motivo_rechazo=null where id=v_informado.id;
  return jsonb_build_object('pago_informado_id',v_informado.id,'estado','Validado','resultado',v_resultado,'idempotente',false);
end;$$;

revoke all on function public.validar_pago_informado(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.validar_pago_informado(uuid,uuid,uuid) to service_role;

-- Backfill only confirmed tournament obligations.
do $$
declare r record; v_primera date;
begin
  for r in
    select c.id cobro_id,c.academia_id,c.fecha_vencimiento,
      greatest(1,coalesce(max(case when tp.respuesta_participacion='Si' then tp.numero_cuotas end),1))::integer total_cuotas
    from public.cobros c join public.torneo_participantes tp on tp.torneo_id=c.torneo_id and tp.jugador_id=c.jugador_id
    where c.torneo_id is not null and c.estado<>'Anulado' and tp.respuesta_participacion='Si'
      and not exists(select 1 from public.cobro_cuotas q where q.cobro_id=c.id)
    group by c.id,c.academia_id,c.fecha_vencimiento
  loop
    if r.total_cuotas>1 then v_primera:=(coalesce(r.fecha_vencimiento,current_date)-((r.total_cuotas-1)*interval '1 month'))::date;
    else v_primera:=coalesce(r.fecha_vencimiento,current_date); end if;
    perform public.generar_cuotas_cobro(r.academia_id,r.cobro_id,r.total_cuotas,v_primera,coalesce(r.fecha_vencimiento,current_date));
  end loop;
end $$;