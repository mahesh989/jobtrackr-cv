-- ============================================================
-- Migration 017: cascade analysis_runs when their cv_version is deleted
--
-- Original FK in migration 011 omitted an ON DELETE clause, so it defaulted
-- to RESTRICT — meaning deleting a CV failed if any analysis_runs row still
-- pointed at it. That blocked the CV library Delete button.
--
-- Change to ON DELETE CASCADE so deleting a CV also removes its analyses.
-- Tailored PDFs in storage will become orphaned (best-effort cleanup is
-- the storage-side responsibility); the DB stays consistent.
-- ============================================================

alter table public.analysis_runs
  drop constraint if exists analysis_runs_cv_version_id_fkey;

alter table public.analysis_runs
  add constraint analysis_runs_cv_version_id_fkey
    foreign key (cv_version_id)
    references public.cv_versions(id)
    on delete cascade;
