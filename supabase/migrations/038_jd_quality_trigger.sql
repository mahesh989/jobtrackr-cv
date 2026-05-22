-- Migration 038 — jd_quality auto-classification trigger + threshold alignment
--
-- Two real bugs found 2026-05-22:
--
-- 1. Migration 032 was a ONE-OFF backfill. Jobs scraped after 032 stayed at
--    jd_quality=NULL because nothing reclassifies on INSERT. Net result:
--    the dashboard's "Needs JD" chip, the TriageBanner counts, and the
--    JobTable "Needs JD" state pill all silently ignored every new job.
--
-- 2. The classification threshold ('thin' = desc < 300 chars in 032) didn't
--    match Phase E-1's skip threshold (worker skips when desc < 2000). A
--    500-char job was 'unknown' per the schema but auto-skipped by the
--    worker — invisible to the user, who saw the job on their board but had
--    no indication WHY automation didn't run on it.
--
-- Fix: a BEFORE INSERT/UPDATE trigger that classifies jd_quality from
-- description length + content markers, using the SAME 2000-char threshold
-- the worker uses. Then a single backfill UPDATE to reclassify every row
-- (including existing 'unknown' rows that should really be 'thin' now).
--
-- After this migration:
--   • New scrape → trigger fires → jd_quality stamped before INSERT commits
--   • User-pasted JD → UPDATE OF description fires trigger → may flip thin→rich
--   • UI "Needs JD" chip / TriageBanner / pipelineState='needs_jd' badge all
--     surface the 5 Sydney jobs and any future thin-JD scrapes

-- ── 1. The classifier function ──────────────────────────────────────────────
-- Single source of truth for jd_quality. If you change the threshold here,
-- also bump JD_MIN_USABLE in worker/src/automation/triggerAutoAnalyze.ts.
CREATE OR REPLACE FUNCTION public.classify_jd_quality(description text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN length(coalesce(description, '')) < 2000 THEN 'thin'
    WHEN description ILIKE '%responsibilit%'
      OR description ILIKE '%requirement%'
      OR description ILIKE '%qualification%'
      OR description ILIKE '%experience%'
      OR description ILIKE '%what you%'
      OR description ILIKE '%about the role%' THEN 'rich'
    ELSE 'unknown'
  END;
$$;

-- ── 2. Trigger to keep jd_quality in sync on every write ───────────────────
CREATE OR REPLACE FUNCTION public.jobs_set_jd_quality()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Use manual_jd_text when present (user pasted full JD) — otherwise the
  -- scraped description field. manual_jd_text wins because Phase E-1 and
  -- the analyze route both honour it as a richer signal.
  NEW.jd_quality := public.classify_jd_quality(
    coalesce(NULLIF(NEW.manual_jd_text, ''), NEW.description)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS jobs_jd_quality_trigger ON public.jobs;

CREATE TRIGGER jobs_jd_quality_trigger
  BEFORE INSERT OR UPDATE OF description, manual_jd_text ON public.jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.jobs_set_jd_quality();

-- ── 3. Backfill — reclassify every row using the new thresholds ─────────────
-- Unlike migration 032 this is NOT idempotent-guarded with `WHERE jd_quality
-- IS NULL`. We deliberately re-classify everything so existing 'unknown'
-- 300-600-char rows that the worker would also skip become 'thin' too.
UPDATE jobs
SET jd_quality = public.classify_jd_quality(
  coalesce(NULLIF(manual_jd_text, ''), description)
);
