-- Migration 040: analysis_runs.cover_letter_status
--
-- Surfaces the outcome of the auto-cover-letter step on every analysis run.
-- Without this, an analysis run can complete cleanly yet have NO letter and
-- the user has no way to see WHY (silently swallowed errors, missing voice
-- profile, idempotency block, etc). With it, the run detail page can show
-- 'Letter triggered ✓' or 'Letter skipped: no voice profile' or
-- 'Letter failed: violates check constraint' — end of mystery.
--
-- Value domain (text, not enum so we can grow it without migration):
--   NULL                     — not attempted yet (still running, OR final
--                              gate not yet reached)
--   'skipped:below_gate'     — tailored score < min_final_ats
--   'skipped:no_voice'       — user has no voice profile saved
--   'skipped:no_story'       — user has no extracted stories
--   'skipped:duplicate'      — a non-stale completed/in-flight letter already
--                              exists for this job
--   'triggered'              — cover_letters row created and generator
--                              pipeline kicked off
--   'failed:<short_reason>'  — INSERT errored or trigger errored. Reason
--                              is the truncated exception summary.
--
-- All writes go through backend/api/app/services/automation/auto_cover_letter.py
-- and orchestrator.py — never from web. Read by the analyze run detail page.

ALTER TABLE analysis_runs
  ADD COLUMN IF NOT EXISTS cover_letter_status text;

COMMENT ON COLUMN analysis_runs.cover_letter_status IS
  'Outcome of the auto-cover-letter step. NULL = not attempted. See migration 040 for the value domain.';
