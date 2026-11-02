-- Convert active academies without a paid contract. Keep their dates and status.
UPDATE public.academias AS a
SET plan = 'Lestra Deportivo',
    plan_codigo = 'alto_rendimiento',
    plan_price_clp = 16798,
    billing_amount_clp = 16798,
    billing_cycle = 'monthly',
    licencia_apoderados = true,
    guardian_price_clp = 0,
    guardian_license_ends_at = NULL,
    max_profesores = greatest(a.max_profesores, 30),
    max_jugadores = greatest(a.max_jugadores, 100000)
WHERE a.subscription_status = 'active'
  AND a.contract_locked_at IS NULL
  AND a.promotion_code IS NULL
  AND a.plan IS DISTINCT FROM 'Lestra Deportivo'
  AND NOT EXISTS (SELECT 1 FROM public.plataforma_cobros c WHERE c.academia_id = a.id);
