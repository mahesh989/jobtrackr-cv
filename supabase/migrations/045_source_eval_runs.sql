-- Migration 045: source_eval_runs
--
-- Beta tool that runs each source adapter in isolation against a synthetic
-- search (free-form keywords + location + posted-within window) and reports
-- per-source counts at every pipeline stage. Dry-run only — never writes to
-- the jobs table. Used to compare adapter coverage, debug source-specific
-- gaps (especially SEEK direct vs Apify), and verify against manual SEEK
-- searches.
--
-- One row per eval session. The `results` jsonb holds one entry per source:
--   {
--     "<source>": {
--       "status":            "pending" | "running" | "done" | "error",
--       "error":             "..."                        -- if status=error
--       "started_at":        "...",
--       "finished_at":       "...",
--       "timing_ms": { "fetch": 1234, "dedup": 12, "jd_enrich": 4567 },
--       "counts": {
--         "fetched":          47,    -- raw jobs returned by adapter
--         "after_url_dedup":  41,    -- minus already-in-DB URL hashes
--         "after_keyword":    38,    -- minus keyword-filter drops
--         "after_smart":      38,    -- minus smart-filter drops (no rules in ad-hoc mode → same)
--         "after_dedup":      35,    -- minus L1+L2 content dedup
--         "would_save":       35,    -- = after_dedup (dry-run skips save)
--         "full_jd":          27,    -- jobs whose description met full-JD threshold
--         "thin_jd":           8     -- jobs with teaser/short description only
--       },
--       "samples": [
--         { "title": "...", "company": "...", "url": "...", "posted_at": "...", "full_jd": true }
--       ]
--     }
--   }

CREATE TABLE IF NOT EXISTS public.source_eval_runs (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  keywords            text[]        NOT NULL,
  location            text,
  posted_within_days  integer       NOT NULL DEFAULT 14,
  sources_requested   text[]        NOT NULL,
  status              text          NOT NULL DEFAULT 'running'
                                    CHECK (status IN ('running', 'completed', 'failed')),
  results             jsonb         NOT NULL DEFAULT '{}'::jsonb,
  unique_total        integer,                  -- distinct URL count across all sources after filtering
  overlap             jsonb,                    -- {url_hash: [sources, ...]} — set on completion
  created_at          timestamptz   NOT NULL DEFAULT now(),
  finished_at         timestamptz
);

CREATE INDEX IF NOT EXISTS idx_source_eval_runs_user
  ON public.source_eval_runs(user_id, created_at DESC);

ALTER TABLE public.source_eval_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own source_eval_runs"
  ON public.source_eval_runs
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.source_eval_runs IS
  'Beta source-coverage eval: per-source dry-run pipeline metrics. Migration 045.';
