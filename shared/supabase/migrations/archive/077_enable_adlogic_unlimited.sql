-- Migration 077 — enable the AdLogic aged-care source (unlimited tier).
--
-- The adlogic adapter (backend/worker/src/sources/adlogic.ts) scrapes aged-care
-- employers on AdLogic (MartianLogic/myRecruitment+) job boards: a Next.js
-- frontend over a public /api/search JSON list endpoint, with full JDs parsed
-- from each SSR detail page's __NEXT_DATA__ blob. First tenant: Moran Health Care
-- (careers.morangroup.com.au, clientCode 'moran'). Multi-tenant (Maroba + more).
--
-- Recon'd 2026-07-01; the adapter fails safe (returns [] / throws -> orchestrator
-- skips) until validated live. Enabled on the UNLIMITED tier only (founders/
-- admins) for validation before paid tiers. Also gated vertical=healthcare.
-- Idempotent.

update public.platform_source_tiers
set enabled_sources = array_append(enabled_sources, 'adlogic'),
    updated_at      = now()
where tier = 'unlimited'
  and not ('adlogic' = any(enabled_sources));
