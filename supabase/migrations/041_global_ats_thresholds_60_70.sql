-- Migration 041: global ATS thresholds (60 initial, 70 final)
--
-- Up to now, each search_profile carried its own min_initial_ats (default 55)
-- and min_final_ats (default 75). User decision: simplify by making the
-- thresholds global constants (60 / 70). Per-profile overrides are removed
-- to keep the rule predictable across the whole app.
--
-- This migration has TWO parts:
--   1. Recompute passed_initial_gate and passed_final_gate on every existing
--      analysis_runs row using the new thresholds, so the dashboard's gate
--      buckets / chips / TriageBanner / donut all reflect the new rule
--      immediately — no per-row re-analysis needed.
--   2. Drop min_initial_ats and min_final_ats from search_profiles. The
--      cv-backend AnalyzeRequest defaults are updated in code to 60/70 and
--      the web/worker layers stop sending profile-specific values.
--
-- Letter generation is NOT auto-triggered for newly-passing existing rows
-- (would burn AI cost on potentially hundreds of jobs). Users who want
-- letters on previously-failed jobs can manually re-analyze them — the
-- new threshold (70) applies on every fresh run.

BEGIN;

-- ── 1. Recompute gate flags on existing analysis_runs ────────────────────────
-- Only rows where the score is known. Rows where initial_ats_score IS NULL
-- (e.g. ran before the column existed) stay NULL — the new rule still applies
-- prospectively.

UPDATE analysis_runs
   SET passed_initial_gate = (initial_ats_score >= 60)
 WHERE initial_ats_score IS NOT NULL;

UPDATE analysis_runs
   SET passed_final_gate = (tailored_match_score >= 70)
 WHERE tailored_match_score IS NOT NULL;

-- ── 2. Drop per-profile threshold columns ────────────────────────────────────
-- The CHECK constraints + NOT NULL + DEFAULTs were added by migration 031.
-- Drop the columns; no app code reads them after this migration ships.

ALTER TABLE search_profiles
  DROP COLUMN IF EXISTS min_initial_ats,
  DROP COLUMN IF EXISTS min_final_ats;

COMMIT;
