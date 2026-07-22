-- 069 — Don't charge a tailored-CV credit for gate-stopped runs.
--
-- Until now the analysis_runs usage trigger (sync_usage_from_artifact, 051)
-- COMMITTED the tailored_cv reservation on ANY completed run. But a run that
-- stops at the initial-ATS gate produces NO tailored CV (step_status.tailored_cv
-- = 'skipped'), so committing the credit charges the user for nothing. This is
-- especially impactful for auto-analyze, which runs across many fetched jobs and
-- gate-skips the low-match ones.
--
-- New behaviour (both manual + auto):
--   completed AND tailored_cv = 'skipped'  -> VOID  (gate-stopped, no CV)
--   completed AND tailored_cv != 'skipped' -> COMMIT (a CV was produced)
--   failed                                 -> VOID
--
-- A later resume (which sets skip_initial_gate=true and always produces a CV)
-- re-reserves a fresh credit in the resume route, so a CV produced on resume is
-- charged exactly once.
--
-- Scoped to analysis_runs via a dedicated function so the cover_letters trigger
-- (still on sync_usage_from_artifact) is untouched — cover_letters has no
-- step_status column and no gate-skip concept.

create or replace function public.sync_usage_from_analysis_run()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if NEW.status = 'completed' then
    if coalesce(NEW.step_status->>'tailored_cv', '') = 'skipped' then
      -- Gate-stopped: no tailored CV produced -> free the reservation.
      update public.usage_events
         set status = 'voided'
       where ref_id = NEW.id and status = 'pending';
    else
      update public.usage_events
         set status = 'committed'
       where ref_id = NEW.id and status = 'pending';
    end if;
  elsif NEW.status = 'failed' then
    update public.usage_events
       set status = 'voided'
     where ref_id = NEW.id and status = 'pending';
  end if;
  return NEW;
end;
$$;

-- Repoint the analysis_runs trigger at the gate-aware function. The
-- cover_letters trigger keeps using sync_usage_from_artifact (unchanged).
drop trigger if exists analysis_runs_usage_sync on public.analysis_runs;
create trigger analysis_runs_usage_sync
  after update of status on public.analysis_runs
  for each row execute function public.sync_usage_from_analysis_run();
