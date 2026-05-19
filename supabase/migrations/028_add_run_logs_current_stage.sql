-- Live progress signal for the pipeline.
--
-- The worker writes a short human-readable string to current_stage at each
-- major stage transition (fetching:adzuna, dedup, saving, ...). The web UI
-- subscribes to run_logs via Supabase realtime and shows the value as a
-- status pill while status='running'. When the row flips to completed/failed
-- the pill is replaced by the final counts already on the row.
--
-- NULL = pre-feature rows or a stage that hasn't been written yet.

alter table public.run_logs
  add column if not exists current_stage text;

comment on column public.run_logs.current_stage is
  'Human-readable label of the stage the pipeline is currently in. '
  'Updated mid-run by the worker for live UI progress. NULL once the run terminates.';
