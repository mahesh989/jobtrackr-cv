-- ============================================================
-- JobTrackr — 002_rls.sql (squashed 2026-07-23)
-- Row Level Security: every ENABLE ROW LEVEL SECURITY + every policy,
-- consolidated from migrations 002–079. Apply AFTER 001_full_schema.sql.
-- ============================================================

-- Enable RLS on every table
alter table public.invite_codes    enable row level security;
alter table public.users           enable row level security;
alter table public.search_profiles enable row level security;
alter table public.jobs            enable row level security;
alter table public.run_logs        enable row level security;
alter table public.ai_cache        enable row level security;
alter table public.user_integrations enable row level security;
alter table public.cv_versions     enable row level security;
alter table public.analysis_runs   enable row level security;
alter table public.user_preferences enable row level security;
alter table public.voice_profiles  enable row level security;
alter table public.stories         enable row level security;
ALTER TABLE public.company_research ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cover_letters   ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications           ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_integrations     ENABLE ROW LEVEL SECURITY;
-- eval_runs: RLS on, NO policies — service-role only (043)
alter table public.eval_runs       enable row level security;
ALTER TABLE public.source_eval_runs ENABLE ROW LEVEL SECURITY;
alter table public.plans           enable row level security;
alter table public.subscriptions   enable row level security;
alter table public.usage_events    enable row level security;
-- stripe_events: no client policy (service-role only; RLS denies all by default).
alter table public.stripe_events   enable row level security;
alter table public.ai_calls        enable row level security;
alter table public.pipeline_timings enable row level security;
alter table public.user_events     enable row level security;
alter table public.admin_audit_log enable row level security;
alter table public.platform_ai_settings enable row level security;
alter table public.platform_sources enable row level security;
alter table public.platform_source_tiers enable row level security;
alter table public.search_coverage enable row level security;
alter table public.global_jobs     enable row level security;
alter table public.profile_jobs    enable row level security;
alter table public.user_engagement enable row level security;
alter table public.profile_pause_state enable row level security;
alter table public.pending_job_notifications enable row level security;

-- ============================================================
-- INVITE CODES
-- Anyone can SELECT (to validate during signup).
-- Only service_role can INSERT/UPDATE (founder uses SQL console or admin API).
-- ============================================================
create policy "invite_codes_read"
  on public.invite_codes for select
  using (true);

-- ============================================================
-- USERS
-- Each user reads/updates only their own row.
-- INSERT handled by trigger (handle_new_user runs as security definer).
-- ============================================================
create policy "users_select_own"
  on public.users for select
  using (id = auth.uid());

create policy "users_update_own"
  on public.users for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- ============================================================
-- SEARCH PROFILES — full CRUD for own profiles only.
-- ============================================================
create policy "profiles_select_own"
  on public.search_profiles for select
  using (user_id = auth.uid());

create policy "profiles_insert_own"
  on public.search_profiles for insert
  with check (user_id = auth.uid());

create policy "profiles_update_own"
  on public.search_profiles for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "profiles_delete_own"
  on public.search_profiles for delete
  using (user_id = auth.uid());

-- ============================================================
-- JOBS — access via profile ownership (join to search_profiles).
-- ============================================================
create policy "jobs_select_own"
  on public.jobs for select
  using (
    exists (
      select 1 from public.search_profiles p
      where p.id = jobs.profile_id
        and p.user_id = auth.uid()
    )
  );

create policy "jobs_insert_own"
  on public.jobs for insert
  with check (
    exists (
      select 1 from public.search_profiles p
      where p.id = jobs.profile_id
        and p.user_id = auth.uid()
    )
  );

create policy "jobs_update_own"
  on public.jobs for update
  using (
    exists (
      select 1 from public.search_profiles p
      where p.id = jobs.profile_id
        and p.user_id = auth.uid()
    )
  );

create policy "jobs_delete_own"
  on public.jobs for delete
  using (
    exists (
      select 1 from public.search_profiles p
      where p.id = jobs.profile_id
        and p.user_id = auth.uid()
    )
  );

-- ============================================================
-- RUN LOGS — same pattern as jobs
-- ============================================================
create policy "run_logs_select_own"
  on public.run_logs for select
  using (
    exists (
      select 1 from public.search_profiles p
      where p.id = run_logs.profile_id
        and p.user_id = auth.uid()
    )
  );

create policy "run_logs_insert_own"
  on public.run_logs for insert
  with check (
    exists (
      select 1 from public.search_profiles p
      where p.id = run_logs.profile_id
        and p.user_id = auth.uid()
    )
  );

-- ============================================================
-- AI CACHE — users can read cache entries for their profiles
-- Worker writes via service_role (bypasses RLS).
-- ============================================================
create policy "ai_cache_select_own"
  on public.ai_cache for select
  using (
    profile_id is null
    or exists (
      select 1 from public.search_profiles p
      where p.id = ai_cache.profile_id
        and p.user_id = auth.uid()
    )
  );

-- ============================================================
-- USER INTEGRATIONS (008) — own rows only. The browser NEVER receives
-- encrypted_api_key (API route strips it); worker uses service-role.
-- ============================================================
create policy "users_own_integrations"
  on public.user_integrations
  for all
  using     (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- CV VERSIONS (010)
-- ============================================================
create policy "users_own_cv_versions"
  on public.cv_versions
  for all
  using     (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- ANALYSIS RUNS (011)
-- ============================================================
create policy "users_own_analysis_runs"
  on public.analysis_runs
  for all
  using     (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- USER PREFERENCES (020)
-- ============================================================
create policy "users_own_preferences"
  on public.user_preferences
  for all
  using     (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- VOICE PROFILES (021)
-- ============================================================
create policy "users_own_voice_profiles"
  on public.voice_profiles
  for all
  using     (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- STORIES (022)
-- ============================================================
create policy "users_own_stories"
  on public.stories
  for all
  using     (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- COMPANY RESEARCH (024) — global cache: all authenticated users read;
-- service-role writes (no client write policy).
-- ============================================================
CREATE POLICY "authenticated_read_company_research"
  ON public.company_research
  FOR SELECT
  USING (auth.role() = 'authenticated');

-- ============================================================
-- COVER LETTERS (025)
-- ============================================================
CREATE POLICY "users_own_cover_letters"
  ON public.cover_letters
  FOR ALL
  USING     (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- APPLICATIONS (031)
-- ============================================================
CREATE POLICY users_own_applications ON applications
  FOR ALL
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- EMAIL INTEGRATIONS (031)
-- ============================================================
CREATE POLICY users_own_email_integration ON email_integrations
  FOR ALL
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- SOURCE EVAL RUNS (045)
-- ============================================================
CREATE POLICY "own source_eval_runs"
  ON public.source_eval_runs
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- BILLING (051) — users read their own rows; only service-role writes.
-- ============================================================
create policy plans_public_read on public.plans
  for select using (true);

create policy subscriptions_own_read on public.subscriptions
  for select using (auth.uid() = user_id);

create policy usage_events_own_read on public.usage_events
  for select using (auth.uid() = user_id);

-- ============================================================
-- ADMIN OBSERVABILITY (055) — founders/admins read all; users read
-- their own user_events. Service-role bypasses RLS entirely.
-- ============================================================
create policy "admin_read_ai_calls" on public.ai_calls
  for select to authenticated
  using (
    exists (select 1 from public.users where id = auth.uid() and role in ('founder','admin'))
  );

create policy "admin_read_pipeline_timings" on public.pipeline_timings
  for select to authenticated
  using (
    exists (select 1 from public.users where id = auth.uid() and role in ('founder','admin'))
  );

create policy "admin_read_user_events" on public.user_events
  for select to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.users where id = auth.uid() and role in ('founder','admin'))
  );

create policy "admin_read_admin_audit_log" on public.admin_audit_log
  for select to authenticated
  using (
    exists (select 1 from public.users where id = auth.uid() and role in ('founder','admin'))
  );

-- ============================================================
-- PLATFORM AI SETTINGS (060) — service-role only.
-- ============================================================
create policy "service role full access" on public.platform_ai_settings
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ============================================================
-- PLATFORM SOURCES (063) — service-role only.
-- ============================================================
create policy "service role full access" on public.platform_sources
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ============================================================
-- PLATFORM SOURCE TIERS (064) — service-role only.
-- ============================================================
create policy "service role full access" on public.platform_source_tiers
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ============================================================
-- SEARCH COVERAGE (066) — service-role only.
-- ============================================================
create policy "service role full access" on public.search_coverage
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ============================================================
-- GLOBAL JOBS (067) — service-role only (reads go via profile_jobs).
-- ============================================================
create policy "service role full access" on public.global_jobs
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ============================================================
-- PROFILE JOBS (068) — per-user access via search_profiles join
-- (mirrors jobs_*_own above).
-- ============================================================
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

-- ============================================================
-- ENGAGEMENT (079) — own read (+ own update for the notify toggle).
-- profile_pause_state: read-only to the user; worker/resume flows use
-- service-role. pending_job_notifications: service-role only, no policies.
-- ============================================================
create policy user_engagement_own_read on public.user_engagement
  for select using (auth.uid() = user_id);

create policy user_engagement_own_update on public.user_engagement
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy profile_pause_state_own_read on public.profile_pause_state
  for select using (auth.uid() = user_id);

-- ============================================================
-- STORAGE POLICIES (013 cvs / tailored-cvs, 036 cover-letters)
-- storage.foldername(name)[1] is the first path segment == owner user_id.
-- Buckets themselves are seeded in 003_seed.sql.
-- ============================================================
create policy "cvs_owner_select"
  on storage.objects for select
  using (bucket_id = 'cvs' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "cvs_owner_insert"
  on storage.objects for insert
  with check (bucket_id = 'cvs' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "cvs_owner_update"
  on storage.objects for update
  using (bucket_id = 'cvs' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "cvs_owner_delete"
  on storage.objects for delete
  using (bucket_id = 'cvs' and auth.uid()::text = (storage.foldername(name))[1]);

-- Tailored-CV bucket — cv-backend writes via service-role; this governs
-- browser download access only.
create policy "tailored_cvs_owner_select"
  on storage.objects for select
  using (bucket_id = 'tailored-cvs' and auth.uid()::text = (storage.foldername(name))[1]);

-- Cover-letters bucket (036)
CREATE POLICY "cover_letters_owner_select"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'cover-letters' AND auth.uid()::text = (storage.foldername(name))[1]);
