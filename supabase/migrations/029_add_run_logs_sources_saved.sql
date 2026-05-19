-- Per-source breakdown of jobs saved in a given run.
--
-- Companion to sources_run text[] (list of adapters that ran) and
-- jobs_saved int (total saved). This jsonb stores the split, e.g.
--   {"adzuna": 5, "greenhouse": 7, "seek": 8}
-- so you can answer "where did the X saved jobs actually come from?"
-- without joining against jobs.

alter table public.run_logs
  add column if not exists sources_saved jsonb;

comment on column public.run_logs.sources_saved is
  'Per-source count of jobs saved in this run, e.g. {"adzuna":5,"seek":8}. '
  'NULL on pre-feature rows or runs that failed before stage 12.';
