-- Migration 071 — enable the remaining aged-care ATS sources (unlimited tier).
--
-- Follows migration 070 (which enabled 'agedcare', the Workday adapter). The
-- direct-from-employer roadmap added four more aged-care adapters, each with its
-- own adapter name so failures are isolated per ATS:
--   agedcare_dayforce — Dayforce (Opal HealthCare, …)
--   pageup            — PageUp (BaptistCare, Calvary, Resthaven, Arcare, SA Health)
--   scout_talent      — Scout Talent (NFP aged-care boards)
--   avature           — Avature (Regis Aged Care)
--
-- Enabled on the UNLIMITED tier only so founders/admins can validate them on
-- their own accounts before exposing to paid tiers. All four are also gated by
-- vertical=healthcare. ⚠ These ATS lists are researched but NOT yet API-validated
-- (see docs/aged-care-ats-map.md) — each adapter fails safe, so enabling them
-- cannot break a run; a misconfigured tenant simply yields no jobs.
--
-- Idempotent: only appends names not already present.

update public.platform_source_tiers
set enabled_sources = (
      select array(
        select distinct unnest(
          enabled_sources || array['agedcare_dayforce', 'pageup', 'scout_talent', 'avature']
        )
      )
    ),
    updated_at = now()
where tier = 'unlimited';
