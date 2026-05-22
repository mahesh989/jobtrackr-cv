-- Migration 037 — cover_letters.analysis_run_id (Phase E-2 bug fix)
--
-- Phase E-2's auto_cover_letter.py was written to insert an analysis_run_id
-- column on cover_letters, but that column was never created (migration 025
-- predated the gated automation pipeline, and the column was only added to
-- the new applications table in migration 031).
--
-- Net effect: every E-2 auto-cover-letter attempt crashed with PG error
-- 42703 (column does not exist), silently swallowed by the broad try/except
-- in auto_generate_cover_letter. No letters were ever produced through E-2.
--
-- This migration adds the missing column with a nullable FK so:
--   - existing rows continue to work (NULL is valid)
--   - new E-2 rows get the run_id stamped (lets us trace letter → run)
--   - manual cover-letter generations (which don't pass run_id) stay NULL

ALTER TABLE cover_letters
  ADD COLUMN IF NOT EXISTS analysis_run_id uuid
    REFERENCES analysis_runs(id) ON DELETE SET NULL;

-- Index for the future "letters by run" lookup (cheap; this table is small)
CREATE INDEX IF NOT EXISTS cover_letters_analysis_run_idx
  ON cover_letters(analysis_run_id)
  WHERE analysis_run_id IS NOT NULL;
