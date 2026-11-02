-- Corrige el importe neto y separa el complemento familiar.
-- No toca cobros pagados, contratos bloqueados, fechas de vencimiento ni datos familiares.
UPDATE public.academias AS a
SET plan_price_clp = 19990,
    billing_amount_clp = 19990,
    guardian_price_clp = 0,
    licencia_apoderados = false,
    guardian_license_ends_at = NULL
WHERE a.plan = 'Lestra Deportivo'
  AND a.contract_locked_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.plataforma_cobros AS c
    WHERE c.academia_id = a.id
      AND c.estado = 'pagado'
      AND c.target_guardian_license = true
  );
