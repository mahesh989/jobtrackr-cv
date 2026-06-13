-- 057_analysis_runs_quality_flags.sql
-- Per-run record of deterministic rewrites the honesty_guard applied to the
-- tailored CV. The frontend surfaces these as a small "we adjusted: …" badge
-- on the analysis page so the user knows what the pipeline changed and why.
--
-- Shape (JSONB array, may be empty/NULL):
--   ["Dimeo Cleaning Excellence: dates omitted (no source dates)",
--    "Summary: 'years experience' framing stripped (source has 3 months in vertical)",
--    "Skills label: 'Technical Skills' → 'Care Skills'"]
-- NULL when the writer was the legacy path (no guard); [] when the w8_verified
-- writer ran and had nothing to rewrite (a clean source/JD match).

ALTER TABLE analysis_runs
  ADD COLUMN IF NOT EXISTS quality_flags JSONB;

COMMENT ON COLUMN analysis_runs.quality_flags IS
  'Honesty-guard rewrite notes from w8_verified tailoring. NULL = legacy path or no run. [] = w8 ran with no rewrites. [..] = list of human-readable adjustments.';
