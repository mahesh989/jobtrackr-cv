-- ============================================================
-- JobTrackr — Migration 001: Full schema
-- Apply via: Supabase Dashboard → SQL Editor → run this file
-- ============================================================

-- Enable extensions needed
create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";   -- Phase 2: dedup fuzzy match (L3, flagged off)

-- ============================================================
-- INVITE CODES
-- ============================================================
create table public.invite_codes (
  code          text primary key,
  created_by    uuid references auth.users on delete set null,
  used_by       uuid references auth.users on delete set null,
  used_at       timestamptz,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ============================================================
-- USERS (public profile extending auth.users)
-- ============================================================
create table public.users (
  id               uuid primary key references auth.users on delete cascade,
  email            text not null,
  role             text not null default 'beta' check (role in ('founder', 'beta', 'admin')),
  invite_code_used text references public.invite_codes(code) on delete set null,
  created_at       timestamptz not null default now()
);

-- Auto-create public.users row when a new auth user is confirmed
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- SEARCH PROFILES
-- ============================================================
create table public.search_profiles (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users on delete cascade,
  name             text not null,
  keywords         text[] not null default '{}',
  location         text not null default '',
  visa_filter_mode text not null default 'probability_sort'
                     check (visa_filter_mode in ('probability_sort', 'any', 'sponsored_only')),
  schedule_cron    text not null default '0 7 */2 * *',  -- every 2 days at 7am
  is_active        boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index idx_search_profiles_user_id on public.search_profiles(user_id);

-- Auto-update updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger search_profiles_updated_at
  before update on public.search_profiles
  for each row execute function public.set_updated_at();

-- ============================================================
-- JOBS
-- ============================================================
create table public.jobs (
  id                uuid primary key default gen_random_uuid(),
  profile_id        uuid not null references public.search_profiles on delete cascade,
  url_hash          text not null,                       -- sha256(canonical_url)
  url               text not null,
  title             text not null,
  company           text not null default '',
  location          text not null default '',
  description       text not null default '',
  source            text not null,                       -- 'adzuna' | 'greenhouse' | etc.
  source_tier       int not null default 1,
  posted_at         timestamptz,
  expires_at        timestamptz,
  is_expired        boolean not null default false,
  is_dead_link      boolean not null default false,
  dedup_status      text not null default 'original'
                      check (dedup_status in ('original', 'duplicate', 'repost')),
  duplicate_of      uuid references public.jobs on delete set null,
  repost_of         uuid references public.jobs on delete set null,
  ai_relevance_score float,                             -- 0-1, null until AI scored
  visa_likelihood   float,                              -- 0-1, null until AI scored
  keywords_matched  text[] not null default '{}',
  seen_at           timestamptz,                        -- when user first viewed
  applied_at        timestamptz,                        -- when user marked applied
  dismissed_at      timestamptz,                        -- when user dismissed
  created_at        timestamptz not null default now(),

  unique (profile_id, url_hash)
);

create index idx_jobs_profile_id          on public.jobs(profile_id);
create index idx_jobs_profile_score       on public.jobs(profile_id, ai_relevance_score desc nulls last);
create index idx_jobs_profile_visa        on public.jobs(profile_id, visa_likelihood desc nulls last);
create index idx_jobs_profile_created     on public.jobs(profile_id, created_at desc);
create index idx_jobs_is_expired          on public.jobs(profile_id, is_expired) where is_expired = false;
create index idx_jobs_is_dead_link        on public.jobs(profile_id, is_dead_link) where is_dead_link = false;
-- pg_trgm index for future dedup L3 fuzzy match (Phase 8)
create index idx_jobs_title_trgm          on public.jobs using gin(title gin_trgm_ops);

-- ============================================================
-- RUN LOGS
-- ============================================================
create table public.run_logs (
  id               uuid primary key default gen_random_uuid(),
  profile_id       uuid not null references public.search_profiles on delete cascade,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  status           text not null default 'running'
                     check (status in ('running', 'completed', 'failed')),
  jobs_fetched     int not null default 0,
  jobs_after_dedup int not null default 0,
  jobs_saved       int not null default 0,
  error_message    text,
  sources_run      text[] not null default '{}',
  created_at       timestamptz not null default now()
);

create index idx_run_logs_profile_id on public.run_logs(profile_id, started_at desc);

-- ============================================================
-- AI CACHE
-- cache_key = sha256(url_hash || ':' || keywords_hash)
-- ============================================================
create table public.ai_cache (
  cache_key    text primary key,                         -- sha256(url_hash:keywords_hash)
  profile_id   uuid references public.search_profiles on delete cascade,
  result_json  jsonb not null,                           -- { relevance_score, visa_likelihood, visa_signals[] }
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '30 days'
);

create index idx_ai_cache_expires_at on public.ai_cache(expires_at);
create index idx_ai_cache_profile_id on public.ai_cache(profile_id);

-- Cleanup function (called periodically or on demand)
create or replace function public.purge_expired_ai_cache()
returns int language plpgsql as $$
declare deleted int;
begin
  delete from public.ai_cache where expires_at < now();
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;
