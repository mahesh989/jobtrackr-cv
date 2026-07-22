-- Migration 075 — enable the Dayforce aged-care source (unlimited tier).
--
-- The agedcare_dayforce adapter (backend/worker/src/sources/agedCareDayforce.ts)
-- bootstraps a CSRF session from the careers page, then POSTs the public
-- jobposting/search API (full JD inline). First tenant: Uniting NSW/ACT
-- (jobs.dayforcehcm.com, namespace unitingaunsw, board UNITINGCCS). Validated
-- 2026-06-29 (146 listed → 66 care roles with full JDs).
--
-- Enabled on the UNLIMITED tier only (founders/admins) for validation before
-- paid tiers. Also gated vertical=healthcare. Idempotent.

update public.platform_source_tiers
set enabled_sources = array_append(enabled_sources, 'agedcare_dayforce'),
    updated_at      = now()
where tier = 'unlimited'
  and not ('agedcare_dayforce' = any(enabled_sources));
