-- ============================================================
-- Migration 011: analysis_runs
--
-- One row per CV-tailoring analysis. Created by JobTrackr when the user
-- clicks "Analyze". Written to by cv-backend (Python pipeline) via service-role.
-- Browser subscribes via Supabase Realtime for live step progress.
--
-- Mirrors cv-magic's analysis_run model with company_id → job_id (FK to jobs).
-- ============================================================

create table public.analysis_runs (
  id                          uuid        primary key default gen_random_uuid(),
  user_id                     uuid        not null references public.users(id) on delete cascade,
  job_id                      uuid        not null references public.jobs(id)   on delete cascade,
  cv_version_id               uuid        not null references public.cv_versions(id),

  -- ── Top-level status ────────────────────────────────────────────────────────
  -- pending  → run created, not yet picked up by cv-backend
  -- running  → at least one step in progress
  -- completed → all steps done, tailored CV generated
  -- failed   → any step threw; error_message populated
  status                      text        not null default 'pending'
                                check (status in ('pending','running','completed','failed')),

  -- Per-step status — 7 pipeline steps from cv-magic. Frontend reads this JSON
  -- and animates the step cards. Each step value is pending|running|completed|failed.
  step_status                 jsonb       not null default jsonb_build_object(
                                'jd_analysis',           'pending',
                                'cv_jd_matching',        'pending',
                                'ats_scoring',           'pending',
                                'input_recommendations', 'pending',
                                'keyword_feasibility',   'pending',
                                'ai_recommendations',    'pending',
                                'tailored_cv',           'pending'
                              ),

  -- ── Input snapshot ──────────────────────────────────────────────────────────
  -- The exact JD text that fed the pipeline. Captured at run start so re-running
  -- the same job (after the listing changes) compares apples to apples.
  jd_text                     text        not null,

  -- ── Step results ────────────────────────────────────────────────────────────
  jd_analysis_result          jsonb,
  cv_jd_matching_result       jsonb,
  ats_scoring_result          jsonb,
  input_recommendations       jsonb,
  keyword_feasibility         jsonb,
  ai_recommendations          text,                       -- markdown

  -- Step 6 outputs
  tailored_cv_storage_path    text,                       -- markdown in Storage
  tailored_pdf_storage_path   text,                       -- ReportLab-rendered PDF
  tailored_ats_scoring_result jsonb,
  injected_keywords           jsonb,

  -- Scores (denormalised for fast filtering on the job board)
  match_score                 integer,
  tailored_match_score        integer,
  ats_lift                    integer,

  -- ── Lifecycle ───────────────────────────────────────────────────────────────
  is_stale                    boolean     not null default false,
  error_message               text,

  started_at                  timestamptz,
  completed_at                timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index idx_analysis_runs_user_id on public.analysis_runs(user_id);
create index idx_analysis_runs_job_id  on public.analysis_runs(job_id);
create index idx_analysis_runs_user_job on public.analysis_runs(user_id, job_id);
create index idx_analysis_runs_status  on public.analysis_runs(status);
-- Fast lookup of "current (non-stale) run for this job"
create index idx_analysis_runs_active
  on public.analysis_runs(user_id, job_id, created_at desc)
  where is_stale = false;

create trigger analysis_runs_updated_at
  before update on public.analysis_runs
  for each row execute function public.set_updated_at();

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table public.analysis_runs enable row level security;

create policy "users_own_analysis_runs"
  on public.analysis_runs
  for all
  using     (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── Realtime publication ─────────────────────────────────────────────────────
-- Frontend subscribes to row-level changes via Supabase Realtime to animate the
-- step cards as cv-backend updates step_status. Browser hits an RLS-filtered
-- channel — users only ever receive their own row updates.
alter publication supabase_realtime add table public.analysis_runs;
