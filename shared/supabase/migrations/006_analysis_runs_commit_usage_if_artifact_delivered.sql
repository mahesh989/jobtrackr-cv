-- ============================================================
-- JobTrackr-CV — 006_analysis_runs_commit_usage_if_artifact_delivered.sql
-- Apply AFTER 005_rls_analysis_runs_cover_letters_readonly.sql.
--
-- Fixes chunk C3b (P0, discovered during C3's independent review) — the
-- SAME underlying finding #49 impact ("unlimited free tailored CVs"),
-- reached through the product's own Stop button rather than a direct REST
-- write, so C3's RLS fix (migration 005) does not touch it.
--
-- Root cause. sync_usage_from_analysis_run() (001_full_schema.sql:1264-1288)
-- voids the linked usage_events reservation whenever status transitions to
-- 'failed', unconditionally — it never checks whether a tailored CV was
-- already produced. cancelAnalysisRun (frontend/web/src/lib/actions/runs.ts)
-- always writes via the service-role client (RLS does not apply to it, so
-- migration 005 doesn't change this path at all) and can land at any point
-- after the tailored-CV writer starts, including after the artifact has
-- already been generated and its storage path recorded on the row.
-- Sequence: user clicks Analyze → pipeline generates + uploads the tailored
-- CV → user clicks Stop → status flips to 'failed' → this trigger voids the
-- reservation → the user still holds SELECT on the row and
-- tailored_cvs_owner_select on the storage bucket, so the "refunded"
-- artifact is still downloadable.
--
-- This migration is the billing-side half of the fix — it makes voiding
-- conditional on whether an artifact actually exists on the row, mirroring
-- the pattern the SAME function already uses for the gate-stopped
-- 'completed' case just above it. The application-side half (closing the
-- narrower race where Stop lands WHILE the artifact is still being
-- generated, so tailored_cv_storage_path is briefly still null at the
-- moment of the trigger's own check) is
-- backend/api/app/services/pipeline/progress.py's save_artifact_if_active
-- + the orchestrator's delete-on-cancel around it — a conditional UPDATE
-- (`status <> 'failed'`) that only persists an artifact path if the run is
-- still active, deleting the just-uploaded object otherwise. The two
-- together close every ordering: cancel-before-persist never lets an
-- artifact land on the row (app-side fix), and cancel-after-persist is
-- correctly billed since the artifact was genuinely delivered (this
-- trigger fix).
--
-- Scope. cover_letters keeps sync_usage_from_artifact() UNCHANGED — traced
-- (see EXECUTION-LOG.md chunk C3b) that cover_letters has no user-reachable
-- cancel action anywhere in the frontend; the only "Cancel" button in that
-- flow dismisses a download-options modal and touches nothing in the
-- database. There is no equivalent race to fix there today.
--
-- Non-Negotiable Decision #6 (additive-only). This is a `create or replace
-- function` on a function this project itself added (069, per the comment
-- already in 001_full_schema.sql) — not a table ALTER, not a change to any
-- pre-existing JobTrackr table or function. The trigger definition
-- (`analysis_runs_usage_sync`) is untouched; only the function body it
-- calls is replaced.
--
-- Rollback (one line): re-run the CREATE OR REPLACE from
-- 001_full_schema.sql:1264-1288 (the unconditional-void version).
-- ============================================================

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
    if NEW.tailored_cv_storage_path is not null then
      -- An artifact was already generated and uploaded before the run was
      -- cancelled/failed (e.g. the user clicked Stop after the tailored CV
      -- was produced but before the pipeline reached its next checkpoint).
      -- The user has a real, deliverable CV — bill for it, don't refund it.
      update public.usage_events
         set status = 'committed'
       where ref_id = NEW.id and status = 'pending';
    else
      update public.usage_events
         set status = 'voided'
       where ref_id = NEW.id and status = 'pending';
    end if;
  end if;
  return NEW;
end;
$$;
