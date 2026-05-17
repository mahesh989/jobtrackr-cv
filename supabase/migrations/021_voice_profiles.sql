-- ============================================================
-- Migration 021: voice_profiles (cover letter — Phase 1, voice fingerprint module)
--
-- One row per user. UPSERT pattern — a new writing sample replaces the
-- existing row (no history kept in Phase 1). The UNIQUE constraint on
-- user_id enforces this at the DB level and creates the implicit B-tree
-- index used for all user_id-filtered lookups.
--
-- voice_sample_raw is never returned to the client after initial submission
-- (application-layer guarantee; enforced in the GET endpoint). It is sent
-- to the AI provider for fingerprint extraction only, with no-training
-- headers where the provider supports them.
--
-- cv-backend writes via service-role key (bypasses RLS). Browser reads
-- its own row via auth.uid() = user_id.
-- ============================================================

create table public.voice_profiles (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null unique references public.users(id) on delete cascade,
  voice_sample_raw         text        not null,
  voice_sample_source      text        not null default 'in_app_capture',
  voice_sample_trust_score float       not null,
  fingerprint              jsonb       not null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- unique constraint on user_id already creates the implicit B-tree index;
-- no separate CREATE INDEX needed for user_id lookups.

create trigger voice_profiles_updated_at
  before update on public.voice_profiles
  for each row execute function public.set_updated_at();

-- RLS — users only see/touch their own row; cv-backend writes via service-role
alter table public.voice_profiles enable row level security;

create policy "users_own_voice_profiles"
  on public.voice_profiles
  for all
  using     (auth.uid() = user_id)
  with check (auth.uid() = user_id);
