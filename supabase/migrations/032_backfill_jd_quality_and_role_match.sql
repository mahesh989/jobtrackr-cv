-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 032 — backfill jd_quality + role_match for existing jobs.
--
-- Companion to 031. Run AFTER 031 has applied successfully.
--
-- Pure SQL. No AI calls. Idempotent — re-running only updates rows whose
-- target column is still NULL, so accidentally running twice is safe.
--
-- jd_quality classification:
--   • 'rich'    — description ≥ 600 chars AND contains a key-section marker
--   • 'thin'    — description < 300 chars
--   • 'unknown' — everything else (the middle band)
--
-- role_match classification (SQL only does 'match' vs 'uncertain'):
--   • 'match'     — any profile keyword appears in the job title
--   • 'uncertain' — no keyword hit in title (we don't auto-mark these as
--                   'mismatch' from SQL — that needs the per-profile
--                   anti-keyword denylist, which lives in JS and grows
--                   from user-dismissed jobs over time)
-- ──────────────────────────────────────────────────────────────────────────────

UPDATE jobs SET jd_quality =
  CASE
    WHEN length(coalesce(description, '')) >= 600
         AND (
           description ILIKE '%responsibilit%' OR
           description ILIKE '%requirement%'   OR
           description ILIKE '%qualification%' OR
           description ILIKE '%experience%'    OR
           description ILIKE '%what you%'      OR
           description ILIKE '%about the role%'
         )
      THEN 'rich'
    WHEN length(coalesce(description, '')) < 300
      THEN 'thin'
    ELSE 'unknown'
  END
WHERE jd_quality IS NULL;

UPDATE jobs j SET role_match =
  CASE
    WHEN EXISTS (
      SELECT 1
        FROM search_profiles p,
             unnest(p.keywords) kw
       WHERE p.id = j.profile_id
         AND j.title ILIKE '%' || kw || '%'
    ) THEN 'match'
    ELSE 'uncertain'
  END
WHERE role_match IS NULL;
