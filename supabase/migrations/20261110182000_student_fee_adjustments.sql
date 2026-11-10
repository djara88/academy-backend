-- Ajustes de tarifas individuales: conserva pagos, audita excepciones y respeta la academia.
CREATE TABLE IF NOT EXISTS public.ajustes_tarifas_deportivas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academia_id uuid NOT NULL REFERENCES public.academias(id) ON DELETE CASCADE,
  jugador_id uuid NOT NULL REFERENCES public.jugadores(id) ON DELETE CASCADE,
  inscripcion_id uuid NOT NULL REFERENCES public.inscripciones_deportivas(id) ON DELETE CASCADE,
  tipo text NOT NULL CHECK (tipo IN ('mensualidad', 'matricula')),
  monto_anterior numeric(12,0) NOT NULL CHECK (monto_anterior >= 0),
  monto_nuevo numeric(12,0) NOT NULL CHECK (monto_nuevo >= 0),
  motivo text NOT NULL CHECK (char_length(btrim(motivo)) BETWEEN 8 AND 500),
  actor_id text NOT NULL,
  cobro_ajustado_id uuid REFERENCES public.cobros(id) ON DELETE SET NULL,
  cobro_monto_anterior numeric(12,0),
  cobro_monto_nuevo numeric(12,0),
  creado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ajustes_tarifas_deportivas_alumno_fecha
  ON public.ajustes_tarifas_deportivas (academia_id, jugador_id, creado_en DESC);
ALTER TABLE public.ajustes_tarifas_deportivas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ajustes_tarifas_deportivas FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.ajustes_tarifas_deportivas TO service_role;

CREATE OR REPLACE FUNCTION public.ajustar_tarifa_deportiva(
  p_academia_id uuid,
  p_jugador_id uuid,
  p_inscripcion_id uuid,
  p_tipo text,
  p_monto_nuevo numeric,
  p_monto_anterior numeric,
  p_motivo text,
  p_actor_id text,
  p_aplicar_cobro_actual boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_inscripcion public.inscripciones_deportivas%ROWTYPE;
  v_cobro public.cobros%ROWTYPE;
  v_old numeric;
  v_target numeric;
  v_current_period date := date_trunc('month', (now() AT TIME ZONE 'America/Santiago')::date)::date;
  v_cobro_id uuid := null;
  v_cobro_anterior numeric := null;
  v_cobro_nuevo numeric := null;
  v_match_count integer := 0;
BEGIN
  IF p_tipo NOT IN ('mensualidad', 'matricula') OR p_tipo IS NULL THEN
    RAISE EXCEPTION 'Tipo de tarifa inválido.' USING ERRCODE = 'P0001';
  END IF;
  IF p_monto_nuevo IS NULL OR p_monto_nuevo < 0 OR p_monto_nuevo > 10000000 OR trunc(p_monto_nuevo) <> p_monto_nuevo THEN
    RAISE EXCEPTION 'El importe debe ser un valor entero entre 0 y 10.000.000 CLP.' USING ERRCODE = 'P0001';
  END IF;
  IF p_monto_anterior IS NULL OR p_monto_anterior < 0 THEN
    RAISE EXCEPTION 'Falta el importe anterior para validar la modificación.' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(btrim(coalesce(p_motivo, ''))) NOT BETWEEN 8 AND 500 THEN
    RAISE EXCEPTION 'Describe el motivo del ajuste (entre 8 y 500 caracteres).' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(btrim(coalesce(p_actor_id, ''))) = 0 THEN
    RAISE EXCEPTION 'No se identificó al responsable del ajuste.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_inscripcion FROM public.inscripciones_deportivas
  WHERE id = p_inscripcion_id AND jugador_id = p_jugador_id AND academia_id = p_academia_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inscripción no encontrada en esta academia.' USING ERRCODE = 'P0001';
  END IF;
  IF v_inscripcion.estado <> 'Activa' THEN
    RAISE EXCEPTION 'Solo se pueden ajustar tarifas de inscripciones activas.' USING ERRCODE = 'P0001';
  END IF;
  v_old := CASE WHEN p_tipo = 'mensualidad' THEN v_inscripcion.monto_mensualidad ELSE v_inscripcion.monto_matricula END;
  IF v_old IS DISTINCT FROM p_monto_anterior THEN
    RAISE EXCEPTION 'La tarifa cambió desde que abriste el formulario. Actualiza la pantalla e inténtalo nuevamente.' USING ERRCODE = 'P0001';
  END IF;
  IF v_old = p_monto_nuevo THEN
    RAISE EXCEPTION 'El nuevo importe debe ser distinto al actual.' USING ERRCODE = 'P0001';
  END IF;

  IF coalesce(p_aplicar_cobro_actual, false) THEN
    SELECT COUNT(*) INTO v_match_count
      FROM public.cobros c
      WHERE c.academia_id = p_academia_id
        AND c.jugador_id = p_jugador_id
        AND c.inscripcion_id = p_inscripcion_id
        AND c.estado <> 'Anulado'
        AND (
          (p_tipo = 'matricula' AND c.tipo_concepto IN ('Matrícula', 'Matricula'))
          OR (p_tipo = 'mensualidad' AND c.tipo_concepto = 'Mensualidad' AND c.periodo_mensualidad = v_current_period)
        );
    IF v_match_count > 1 THEN
      RAISE EXCEPTION 'Hay varios cobros para el período. Revisa la cuenta corriente antes de modificar el importe.' USING ERRCODE = 'P0001';
    END IF;
    IF v_match_count = 1 THEN
      SELECT * INTO v_cobro FROM public.cobros c
      WHERE c.academia_id = p_academia_id
        AND c.jugador_id = p_jugador_id
        AND c.inscripcion_id = p_inscripcion_id
        AND c.estado <> 'Anulado'
        AND (
          (p_tipo = 'matricula' AND c.tipo_concepto IN ('Matrícula', 'Matricula'))
          OR (p_tipo = 'mensualidad' AND c.tipo_concepto = 'Mensualidad' AND c.periodo_mensualidad = v_current_period)
        )
      FOR UPDATE;
      v_target := coalesce(v_cobro.monto, 0) + p_monto_nuevo - v_old;
      IF v_target < 0 THEN
        RAISE EXCEPTION 'El descuento supera el importe del cobro. Requiere ajuste contable manual.' USING ERRCODE = 'P0001';
      END IF;
      IF v_target < coalesce(v_cobro.monto_pagado, 0) THEN
        RAISE EXCEPTION 'El importe ajustado no puede ser menor a lo ya pagado. Requiere gestionar devolución o nota de crédito.' USING ERRCODE = 'P0001';
      END IF;
      IF v_cobro.estado = 'Pagado' THEN
        RAISE EXCEPTION 'No se pueden modificar cobros ya pagados. Aplica el ajuste solo a tarifas futuras.' USING ERRCODE = 'P0001';
      END IF;
      v_cobro_id := v_cobro.id;
      v_cobro_anterior := v_cobro.monto;
      v_cobro_nuevo := v_target;
      UPDATE public.cobros
         SET monto = v_target,
             estado = CASE WHEN v_target = coalesce(v_cobro.monto_pagado,0) THEN 'Pagado'
                           WHEN coalesce(v_cobro.monto_pagado,0) > 0 THEN 'Parcial'
                           ELSE 'Pendiente' END
       WHERE id = v_cobro_id AND academia_id = p_academia_id;
    END IF;
  END IF;

  IF p_tipo = 'mensualidad' THEN
    UPDATE public.inscripciones_deportivas
      SET monto_mensualidad = p_monto_nuevo, updated_at = now()
      WHERE id = p_inscripcion_id AND academia_id = p_academia_id;
    IF v_inscripcion.es_principal THEN
      UPDATE public.jugadores SET monto_mensualidad = p_monto_nuevo
      WHERE id = p_jugador_id AND academia_id = p_academia_id;
    END IF;
  ELSE
    UPDATE public.inscripciones_deportivas
      SET monto_matricula = p_monto_nuevo, updated_at = now()
      WHERE id = p_inscripcion_id AND academia_id = p_academia_id;
    IF v_inscripcion.es_principal THEN
      UPDATE public.jugadores SET monto_matricula = p_monto_nuevo
      WHERE id = p_jugador_id AND academia_id = p_academia_id;
    END IF;
  END IF;

  INSERT INTO public.ajustes_tarifas_deportivas (
    academia_id, jugador_id, inscripcion_id, tipo, monto_anterior, monto_nuevo,
    motivo, actor_id, cobro_ajustado_id, cobro_monto_anterior, cobro_monto_nuevo
  ) VALUES (
    p_academia_id, p_jugador_id, p_inscripcion_id, p_tipo, v_old, p_monto_nuevo,
    btrim(p_motivo), p_actor_id, v_cobro_id, v_cobro_anterior, v_cobro_nuevo
  );

  IF v_cobro_id IS NOT NULL THEN
    PERFORM public.recalcular_estado_financiero_academia(p_academia_id);
  END IF;
  RETURN jsonb_build_object(
    'tipo',p_tipo,'anterior',v_old,'nuevo',p_monto_nuevo,
    'cobro_ajustado',v_cobro_id IS NOT NULL,'cobro_id',v_cobro_id,
    'cobro_anterior',v_cobro_anterior,'cobro_nuevo',v_cobro_nuevo
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ajustar_tarifa_deportiva(uuid,uuid,uuid,text,numeric,numeric,text,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ajustar_tarifa_deportiva(uuid,uuid,uuid,text,numeric,numeric,text,text,boolean) TO service_role;
