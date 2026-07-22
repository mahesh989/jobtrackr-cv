-- Migration 062 — align jd_quality threshold to 1000 chars.
--
-- Migration 050 set the 'thin' boundary at 1400 chars. We're lowering it to
-- 1000 so it matches MANUAL_JD_MIN_CHARS (web jobFilters.ts) — the length a
-- pasted JD must reach to count as "usable". Previously a 1000–1399 char JD
-- was no longer flagged "needs JD" (jobNeedsJd keys off manual_jd_text >= 1000)
-- yet was still LABELLED jd_quality='thin', an inconsistent boundary. Now a JD
-- that crosses 1000 chars is treated as a full JD everywhere.
--
-- 1000 is still well clear of the Adzuna API teaser ceiling (~600 chars), so
-- API-only teasers stay 'thin' and continue to get full-JD enrichment; only
-- the 1000–1399 band flips thin → rich/unknown.
--
-- The trigger (jobs_jd_quality_trigger, fires on description/manual_jd_text
-- writes) is unchanged — it calls this function, so replacing the function and
-- re-backfilling is enough.

CREATE OR REPLACE FUNCTION public.classify_jd_quality(description text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN length(coalesce(description, '')) < 1000 THEN 'thin'
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
