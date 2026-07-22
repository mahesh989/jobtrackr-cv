-- Migration 070 — enable the direct-from-employer aged-care source for testing.
--
-- The agedCareWorkday adapter (backend/worker/src/sources/agedCareWorkday.ts)
-- scrapes aged-care providers on the Workday ATS via the public CXS JSON API.
-- It is registered in the worker but won't run until its adapter name
-- ("agedcare") is present in a tier's enabled_sources (migration 064's
-- platform_source_tiers). It is also vertical=healthcare, so it only fires for
-- profiles targeting the healthcare vertical.
--
-- We enable it on the UNLIMITED tier only — founders/admins always resolve to
-- unlimited, so this lets the source be validated on our own accounts before
-- exposing it to paid weekly/monthly tiers.
--
-- Idempotent: the WHERE guard skips the update if 'agedcare' is already present,
-- so re-running this migration is a no-op.

update public.platform_source_tiers
set enabled_sources = array_append(enabled_sources, 'agedcare'),
    updated_at      = now()
where tier = 'unlimited'
  and not ('agedcare' = any(enabled_sources));
