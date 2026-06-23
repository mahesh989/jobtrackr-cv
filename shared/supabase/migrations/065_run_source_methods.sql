-- Migration 065 — per-run source-method tracking.
--
-- Adds a nullable JSONB column to run_logs so the worker can record, per run,
-- exactly which source method was used and whether any paid-tier fallback fired.
-- Shape written by the orchestrator:
--
--   {
--     "tier": "unlimited" | "monthly" | "weekly",
--     "seek":      { "enabled": bool, "listings": "direct"|"apify"|"apify_fallback"|"apify_failed"|"skipped",
--                    "jd": "direct"|"teaser", "merged": int, "fetched": int, "count": int },
--     "adzuna":    { "enabled": bool, "method": "api"|"direct",
--                    "enrichment": "none"|"actor"|"actor_failed_teaser"|"direct_curl"|"direct_curl_failed_teaser",
--                    "merged": int, "fetched": int },
--     "careerjet": { "enabled": bool, "method": "api" }
--   }
--
-- Additive only — existing rows get NULL (no backfill needed).

alter table public.run_logs
  add column if not exists source_methods jsonb;
