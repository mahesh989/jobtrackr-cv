-- Migration 068 — profile_jobs: per-user link + state for the global bucket.
--
-- Phase B of the global-job-bucket plan (docs/global-job-bucket-plan.md).
--
-- One row per (profile, global_job). Holds everything that is per-USER and must
-- NOT be shared in the global bucket: which of the user's keywords matched, their
-- CV-relative relevance score, their distance, their JD edits/contact, and their
-- seen/applied/dismissed lifecycle. RLS-scoped via search_profiles, identical to
-- the existing `jobs` policies (migration 002) so the browser client only ever
-- sees its own rows.
--
-- DORMANT until USE_GLOBAL_BUCKET is enabled and the read path is switched.
--
-- NOTE: analysis_runs.job_id still references `jobs` at this phase. Repointing it
-- to profile_jobs is a cutover-phase migration (open decision #1) and is NOT done
-- here.

create table if not exists public.profile_jobs (
  id               uuid primary key default gen_random_uuid(),
  profile_id       uuid not null references public.search_profiles(id) on delete cascade,
  global_job_id    uuid not null references public.global_jobs(id) on delete cascade,

  keywords_matched text[] not null default '{}',  -- which of THIS user's keywords hit
  ai_relevance_score float,                        -- per-user (depends on their CV)
  distance_km      numeric,                        -- per-user (their home address)
  distance_method  text,

  manual_jd_text   text,                           -- user's own JD edits
  contact_email    text,                           -- user's own recruiter contact

  seen_at          timestamptz,
  applied_at       timestamptz,
  dismissed_at     timestamptz,
  pool_decision_at timestamptz,
  is_starred       boolean not null default false,

  created_at       timestamptz not null default now(),
  unique (profile_id, global_job_id)
);

create index if not exists idx_profile_jobs_profile_created
  on public.profile_jobs (profile_id, created_at desc);
create index if not exists idx_profile_jobs_global_job
  on public.profile_jobs (global_job_id);

alter table public.profile_jobs enable row level security;

-- Per-user access via join to search_profiles (mirrors jobs_*_own in 002).
create policy "profile_jobs_select_own"
  on public.profile_jobs for select
  using (
    exists (
      select 1 from public.search_profiles p
      where p.id = profile_jobs.profile_id
        and p.user_id = auth.uid()
    )
  );

create policy "profile_jobs_insert_own"
  on public.profile_jobs for insert
  with check (
    exists (
      select 1 from public.search_profiles p
      where p.id = profile_jobs.profile_id
        and p.user_id = auth.uid()
    )
  );

create policy "profile_jobs_update_own"
  on public.profile_jobs for update
  using (
    exists (
      select 1 from public.search_profiles p
      where p.id = profile_jobs.profile_id
        and p.user_id = auth.uid()
    )
  );

create policy "profile_jobs_delete_own"
  on public.profile_jobs for delete
  using (
    exists (
      select 1 from public.search_profiles p
      where p.id = profile_jobs.profile_id
        and p.user_id = auth.uid()
    )
  );
