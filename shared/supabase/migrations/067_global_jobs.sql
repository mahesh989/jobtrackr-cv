-- Migration 067 — global_jobs: the canonical, deduplicated job bucket.
--
-- Phase B of the global-job-bucket plan (docs/global-job-bucket-plan.md).
--
-- One row per canonical posting (unique on url_hash), shared across all users.
-- Holds only properties of the POSTING — never per-user state (that lives in
-- profile_jobs, migration 068). Service-role only: the worker writes it; no
-- end-user client reads it directly (reads go via profile_jobs). Mirrors the
-- access pattern of platform_sources (063).
--
-- DORMANT until the worker's USE_GLOBAL_BUCKET flag is enabled AND the read
-- path is switched (later). Creating the table alone changes nothing.
--
-- JD tier gating (read-time, enforced by the projection that reads this table):
--   jd_access = 'all'            full JD is free-for-everyone (SEEK direct, Careerjet)
--             = 'unlimited_only' full JD is a paid feature (Adzuna actor); weekly/monthly
--                                readers get description_snippet instead
--             = 'snippet'        no full JD captured yet

create table if not exists public.global_jobs (
  id                  uuid primary key default gen_random_uuid(),
  url_hash            text not null unique,        -- sha256(canonicalUrl)
  canonical_url       text not null,
  source              text not null,
  source_tier         int not null default 1,

  title               text not null,
  company             text not null default '',
  location            text not null default '',
  location_cell       text not null default '',    -- normaliseCity(location)
  lat                 double precision,            -- geocoded once, shared (null until enriched)
  lng                 double precision,

  matched_keywords    text[] not null default '{}', -- union of every keyword that surfaced this row

  description_snippet text,                          -- always present (API/list snippet)
  description_full    text,                          -- nullable; full JD when scraped
  jd_access           text not null default 'snippet'
                      check (jd_access in ('snippet', 'all', 'unlimited_only')),
  jd_quality          int,

  salary_min          numeric,
  salary_max          numeric,
  visa_likelihood     float,                         -- property of the job -> global
  sponsorship_status  text,
  citizen_pr_only     boolean,

  posted_at           timestamptz,
  first_seen_at       timestamptz not null default now(),  -- reliable eviction clock
  last_seen_at        timestamptz not null default now(),  -- last scrape that re-saw it
  expires_at          timestamptz,
  is_expired          boolean not null default false,
  is_dead_link        boolean not null default false,

  dedup_status        text not null default 'original',
  duplicate_of        uuid references public.global_jobs(id) on delete set null,
  repost_of           uuid references public.global_jobs(id) on delete set null,

  created_at          timestamptz not null default now()
);

create index if not exists idx_global_jobs_location_cell on public.global_jobs (location_cell);
create index if not exists idx_global_jobs_matched_keywords on public.global_jobs using gin (matched_keywords);
create index if not exists idx_global_jobs_posted_at on public.global_jobs (posted_at desc);
create index if not exists idx_global_jobs_first_seen_at on public.global_jobs (first_seen_at desc);

alter table public.global_jobs enable row level security;

-- Service-role only — the worker writes/reads with the service-role client.
-- End-user clients never touch this table directly (they read via profile_jobs).
create policy "service role full access" on public.global_jobs
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
