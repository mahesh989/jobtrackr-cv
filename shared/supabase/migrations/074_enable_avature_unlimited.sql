-- Migration 074 — enable the Avature aged-care source (unlimited tier).
--
-- The avature adapter (backend/worker/src/sources/avature.ts) scrapes aged-care
-- employers on Avature career sites. Unlike Workday/Radancy it parses the full
-- JD inline from the server-rendered listing (no JSON-LD, no detail fetch).
-- First tenant: Regis Aged Care (regis.avature.net, 84 homes). Validated
-- 2026-06-29 (120 listed → 59 care roles with full JDs).
--
-- Enabled on the UNLIMITED tier only (founders/admins) for validation before
-- paid tiers. Also gated vertical=healthcare. Idempotent.

update public.platform_source_tiers
set enabled_sources = array_append(enabled_sources, 'avature'),
    updated_at      = now()
where tier = 'unlimited'
  and not ('avature' = any(enabled_sources));
