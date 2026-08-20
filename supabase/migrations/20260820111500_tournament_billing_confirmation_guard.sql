-- Enforce the business rule: invitation != debt.
create or replace function private.guard_tournament_charge_confirmation()
returns trigger language plpgsql set search_path='public','pg_temp'
as $$
begin
  if new.torneo_id is null or new.jugador_id is null then return new; end if;
  if exists(select 1 from public.torneo_participantes tp where tp.torneo_id=new.torneo_id and tp.jugador_id=new.jugador_id and tp.respuesta_participacion='Si') then return new; end if;
  return null;
end;$$;

drop trigger if exists trg_guard_tournament_charge_confirmation on public.cobros;
create trigger trg_guard_tournament_charge_confirmation before insert on public.cobros
for each row when(new.torneo_id is not null) execute function private.guard_tournament_charge_confirmation();

create or replace function private.sync_tournament_finance_from_participation()
returns trigger language plpgsql set search_path='public','pg_temp'
as $$
declare
  v_torneo public.torneos%rowtype; v_cobro public.cobros%rowtype; v_confirmado boolean; v_espera_cuotas boolean;
  v_total_cuotas integer; v_fecha_final date; v_fecha_primera date;
begin
  select * into v_torneo from public.torneos where id=new.torneo_id;
  if not found then return new; end if;
  select exists(select 1 from public.torneo_participantes tp where tp.torneo_id=new.torneo_id and tp.jugador_id=new.jugador_id and tp.respuesta_participacion='Si') into v_confirmado;
  select * into v_cobro from public.cobros c where c.academia_id=v_torneo.academia_id and c.torneo_id=new.torneo_id and c.jugador_id=new.jugador_id for update;

  if not v_confirmado or coalesce(v_torneo.costo_inscripcion,0)<=0 then
    if found and coalesce(v_cobro.monto_pagado,0)<=0 then
      update public.cobros set estado='Anulado' where id=v_cobro.id;
      update public.cobro_cuotas set estado='Anulada',updated_at=now() where cobro_id=v_cobro.id;
      perform public.recalcular_estado_financiero_academia(v_torneo.academia_id);
    end if;
    return new;
  end if;

  if not found then
    insert into public.cobros(academia_id,jugador_id,inscripcion_id,sede_id,rama_id,torneo_id,concepto,tipo_concepto,monto,monto_pagado,estado,fecha_vencimiento)
    values(v_torneo.academia_id,new.jugador_id,new.inscripcion_id,v_torneo.sede_id,v_torneo.rama_id,v_torneo.id,
      'Inscripción '||v_torneo.nombre,'Torneo',v_torneo.costo_inscripcion,0,'Pendiente',coalesce(v_torneo.fecha_inicio,current_date))
    returning * into v_cobro;
  elsif coalesce(v_cobro.monto_pagado,0)<=0 then
    update public.cobros set estado='Pendiente',monto=v_torneo.costo_inscripcion,fecha_vencimiento=coalesce(v_torneo.fecha_inicio,current_date),
      inscripcion_id=coalesce(new.inscripcion_id,inscripcion_id),sede_id=coalesce(v_torneo.sede_id,sede_id),rama_id=coalesce(v_torneo.rama_id,rama_id)
    where id=v_cobro.id returning * into v_cobro;
  end if;

  select exists(select 1 from public.torneo_participantes tp where tp.torneo_id=new.torneo_id and tp.jugador_id=new.jugador_id
    and tp.respuesta_participacion='Si' and tp.paso_bot='ESPERANDO_CUOTAS') into v_espera_cuotas;

  if v_espera_cuotas then
    if coalesce(v_cobro.monto_pagado,0)<=0 then delete from public.cobro_cuotas where cobro_id=v_cobro.id; end if;
  else
    if v_torneo.permite_cuotas then
      select greatest(1,least(coalesce(v_torneo.max_cuotas,1),coalesce(max(tp.numero_cuotas),1)))::integer into v_total_cuotas
      from public.torneo_participantes tp where tp.torneo_id=new.torneo_id and tp.jugador_id=new.jugador_id and tp.respuesta_participacion='Si';
    else v_total_cuotas:=1; end if;
    v_fecha_final:=coalesce(v_torneo.fecha_inicio,current_date); v_fecha_primera:=current_date;
    perform public.generar_cuotas_cobro(v_torneo.academia_id,v_cobro.id,greatest(1,coalesce(v_total_cuotas,1)),v_fecha_primera,v_fecha_final);
  end if;
  perform public.recalcular_estado_financiero_academia(v_torneo.academia_id);
  return new;
end;$$;

drop trigger if exists trg_sync_tournament_finance_from_participation on public.torneo_participantes;
create trigger trg_sync_tournament_finance_from_participation
after insert or update of respuesta_participacion,pago_en_cuotas,numero_cuotas,paso_bot on public.torneo_participantes
for each row execute function private.sync_tournament_finance_from_participation();

update public.cobros c set estado='Anulado'
where c.torneo_id is not null and coalesce(c.monto_pagado,0)=0 and c.estado<>'Anulado'
and not exists(select 1 from public.torneo_participantes tp where tp.torneo_id=c.torneo_id and tp.jugador_id=c.jugador_id and tp.respuesta_participacion='Si');

update public.cobro_cuotas q set estado='Anulada',updated_at=now()
where exists(select 1 from public.cobros c where c.id=q.cobro_id and c.estado='Anulado');