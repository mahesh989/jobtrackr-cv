-- Migration 076 — enable the SuccessFactors aged-care source (unlimited tier).
--
-- The successfactors adapter (backend/worker/src/sources/successFactors.ts)
-- scrapes aged-care employers on SAP SuccessFactors "Career Site Builder" sites:
-- server-rendered /search/?startrow=N listing → JSON-LD detail (like Radancy).
-- First tenant: Australian Unity (careers.australianunity.com.au).
--
-- ⚠ UNVALIDATED as of 2026-06-30 — built from the documented SF CSB pattern; the
-- adapter fails safe (returns [] / throws → orchestrator skips) until the user
-- validates it live. Enabling it here is harmless meanwhile.
--
-- Enabled on the UNLIMITED tier only (founders/admins) for validation before
-- paid tiers. Also gated vertical=healthcare. Idempotent.

update public.platform_source_tiers
set enabled_sources = array_append(enabled_sources, 'successfactors'),
    updated_at      = now()
where tier = 'unlimited'
  and not ('successfactors' = any(enabled_sources));
