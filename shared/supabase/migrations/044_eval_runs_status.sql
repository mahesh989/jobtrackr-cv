-- 044_eval_runs_status.sql
-- Patch: add lifecycle columns to eval_runs.
--
-- 043_eval_runs.sql was applied while the file did not yet contain the
-- background-pattern status/error columns. Since `create table if not exists`
-- is a no-op once the table exists, a second run of 043 would not add them.
-- This migration brings the live table up to spec.
--
-- Safe to apply more than once: every statement uses `if not exists`.
-- Rollback: `alter table public.eval_runs drop column status, drop column error;`

alter table public.eval_runs
  add column if not exists status text not null default 'running',
  add column if not exists error  text;

-- PostgREST caches the schema; reload so the new columns are visible immediately.
notify pgrst, 'reload schema';
