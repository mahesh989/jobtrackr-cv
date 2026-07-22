-- Migration 072 — pause the non-Workday aged-care sources.
--
-- After live validation (2026-06-29) only the Workday aged-care adapter
-- ('agedcare') yields full JDs. Dayforce/PageUp/Scout Talent/Avature are paused
-- in the worker (commented out of the adapters[] registry) until their JSON APIs
-- are captured (see docs/aged-care-ats-map.md). This removes the names that
-- migration 071 added so platform_source_tiers matches the running config — they
-- would otherwise sit enabled with no adapter behind them.
--
-- Idempotent: rebuilds enabled_sources without the paused names. 'agedcare'
-- (Workday, enabled by migration 070) is preserved.

update public.platform_source_tiers
set enabled_sources = array(
      select unnest(enabled_sources)
      except
      select unnest(array['agedcare_dayforce', 'pageup', 'scout_talent', 'avature'])
    ),
    updated_at = now()
where tier = 'unlimited';
