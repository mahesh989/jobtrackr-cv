-- ============================================================
-- JobTrackr — Migration 002: Row Level Security
-- Apply AFTER 001_schema.sql
-- ============================================================

-- Enable RLS on every table
alter table public.invite_codes    enable row level security;
alter table public.users           enable row level security;
alter table public.search_profiles enable row level security;
alter table public.jobs            enable row level security;
alter table public.run_logs        enable row level security;
alter table public.ai_cache        enable row level security;

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
-- SEARCH PROFILES
-- Full CRUD for own profiles only.
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
-- JOBS
-- Access via profile ownership (join to search_profiles).
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
-- ADMIN HELPER: verify RLS is enforced
-- Run this as an anon/authenticated user to confirm isolation.
-- Expected: 0 rows if no profiles belong to the signed-in user.
-- ============================================================
-- select count(*) from public.jobs;           -- should return only own jobs
-- select count(*) from public.search_profiles; -- should return only own profiles
