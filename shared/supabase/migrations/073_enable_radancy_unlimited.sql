-- Migration 073 — enable the Radancy/TalentBrew aged-care source (unlimited tier).
--
-- The radancy adapter (backend/worker/src/sources/radancy.ts) scrapes aged-care
-- employers on Radancy/TalentBrew career sites via their server-rendered job
-- links + JSON-LD detail pages. First tenant: Bupa AU (careers.bupa.com.au) —
-- Bupa's AU aged-care roles, which are NOT on its Workday board. Validated
-- 2026-06-29 (detail pages return clean JSON-LD JDs).
--
-- Enabled on the UNLIMITED tier only (founders/admins) for validation before
-- paid tiers. Also gated vertical=healthcare. Idempotent.

update public.platform_source_tiers
set enabled_sources = array_append(enabled_sources, 'radancy'),
    updated_at      = now()
where tier = 'unlimited'
  and not ('radancy' = any(enabled_sources));
