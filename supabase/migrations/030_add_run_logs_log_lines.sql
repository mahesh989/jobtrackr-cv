-- Append-only log stream per pipeline run.
--
-- The worker intercepts console.log/console.error inside the run scope and
-- calls append_run_log_line() once per line. The web app polls this column
-- and renders a scrolling monospace console for live observability — same
-- data you see in `fly logs`, surfaced inside the product.
--
-- Stored as jsonb array of {t: ISO timestamp, msg: string}.
-- A typical run produces 30-80 lines, ~5-10 KB. Set a cap if a future
-- pathological run blows up; right now we trust the worker not to spam.

alter table public.run_logs
  add column if not exists log_lines jsonb not null default '[]'::jsonb;

comment on column public.run_logs.log_lines is
  'Append-only array of {t, msg} entries captured from worker console output '
  'during the run. Powers the live "scrolling console" UI on the jobs/runs pages.';

-- Atomic single-line append. Using a function (vs read-modify-write from JS)
-- avoids lost-update races when multiple logs land in the same tick.
create or replace function public.append_run_log_line(rid uuid, line jsonb)
returns void
language sql
as $$
  update public.run_logs
  set log_lines = coalesce(log_lines, '[]'::jsonb) || jsonb_build_array(line)
  where id = rid;
$$;
