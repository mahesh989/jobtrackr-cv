-- ============================================================
-- Migration 054: search_profiles.is_manual
--
-- A "manual" profile is the user's personal Saved Jobs bucket for jobs they
-- find themselves (not via the worker scraper). One per user, auto-provisioned
-- on first use, non-deletable from the UI.
--
-- Key invariants:
--   • is_manual = true  → worker scheduler NEVER runs a fetch for this profile
--   • is_active  is set false, schedule_cron is empty — belt-and-suspenders so
--     even without the explicit is_manual check, the scheduler skips it
--   • The profile is created via upsert so re-running is safe (idempotent)
-- ============================================================

alter table public.search_profiles
  add column if not exists is_manual boolean not null default false;

comment on column public.search_profiles.is_manual is
  'True for the per-user "Saved Jobs" profile. Never fetched by the worker. '
  'Auto-provisioned on first Add Job action. Non-deletable from the UI.';

create index if not exists idx_search_profiles_manual
  on public.search_profiles(user_id)
  where is_manual = true;
