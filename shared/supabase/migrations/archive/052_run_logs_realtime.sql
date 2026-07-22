-- Enable Supabase Realtime for run_logs so the dashboard RunNotifier can
-- receive run-status changes as a push instead of polling /api/user/runs.
--
-- Background: RunNotifier (mounted on every dashboard page) previously polled
-- on a fixed interval because run_logs was never added to the realtime
-- publication — unlike analysis_runs (011), cover_letters (025) and
-- applications (031), which all are. With this in place RunNotifier subscribes
-- to run_logs UPDATEs and toasts the moment a pipeline run flips to
-- completed/failed; a slow backstop poll remains only as a safety net.
--
-- RLS (run_logs_select_own, migration 002) already scopes SELECT to the
-- owning user via search_profiles.user_id, so Realtime — which enforces the
-- subscriber's RLS at the broadcast layer — delivers only that user's rows.
--
-- Idempotent: ADD TABLE errors if the table is already a publication member
-- (e.g. enabled earlier via the Supabase dashboard), so guard with a DO block.

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'run_logs'
  ) then
    alter publication supabase_realtime add table public.run_logs;
  end if;
end
$$;
