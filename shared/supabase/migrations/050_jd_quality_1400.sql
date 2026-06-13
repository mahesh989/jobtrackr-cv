-- Migration 050 — align jd_quality threshold to 1400 chars.
--
-- Migration 038 classified jd_quality='thin' below 2000 chars. The worker and
-- analyze route were later lowered to 1400 (2026-05-27, to clear the Adzuna API
-- teaser ceiling — see JD_MIN_USABLE in worker/src/automation/triggerAutoAnalyze.ts
-- and JD_FULL_THRESHOLD in web/src/app/api/jobs/[id]/analyze/route.ts), but the
-- DB classifier was missed. That left jobs in the 1400–1999 band marked 'thin'
-- while the pipeline happily analysed them — an inconsistent boundary.
--
-- This re-defines the classifier at 1400 and re-backfills every row. The trigger
-- itself (jobs_jd_quality_trigger, fires on description/manual_jd_text writes)
-- is unchanged — it calls this function, so updating the function is enough.

CREATE OR REPLACE FUNCTION public.classify_jd_quality(description text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN length(coalesce(description, '')) < 1400 THEN 'thin'
    WHEN description ILIKE '%responsibilit%'
      OR description ILIKE '%requirement%'
      OR description ILIKE '%qualification%'
      OR description ILIKE '%experience%'
      OR description ILIKE '%what you%'
      OR description ILIKE '%about the role%' THEN 'rich'
    ELSE 'unknown'
  END;
$$;

-- Re-backfill using the effective JD text (manual paste wins over scrape),
-- mirroring the trigger's coalesce so counts line up with what the user sees.
UPDATE jobs
SET jd_quality = public.classify_jd_quality(
  coalesce(NULLIF(manual_jd_text, ''), description)
);
