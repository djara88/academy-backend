drop trigger if exists trg_sync_tournament_finance_from_participation on public.torneo_participantes;
drop trigger if exists trg_guard_tournament_charge_confirmation on public.cobros;
drop function if exists private.sync_tournament_finance_from_participation();
drop function if exists private.guard_tournament_charge_confirmation();

-- This rollback intentionally does not reactivate legacy unconfirmed tournament
-- charges that were annulled by the migration. No payment records are deleted.