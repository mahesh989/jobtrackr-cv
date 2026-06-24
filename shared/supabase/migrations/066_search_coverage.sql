-- Migration 066 — search_coverage: the global job-bucket freshness ledger.
--
-- Phase A of the global-job-bucket plan (docs/global-job-bucket-plan.md).
--
-- One row per search SLICE = (normalised keyword × location-cell × source).
-- Records when that slice was last refreshed from the source and how far back
-- we have backfilled it. Phase B will read this to decide the scrape DELTA
-- ([last_refreshed_at, now]) instead of re-fetching the user's whole window,
-- and to serve cached postings from the bucket. In Phase A it is WRITE-ONLY:
-- the worker populates it after each run so the data is warm when Phase B
-- flips the read on. Nothing reads it yet, so this migration is inert for
-- existing flows.
--
-- Additive only — no existing table is altered. Service-role only (worker
-- writes it with the service-role client; no end-user client touches it),
-- mirroring platform_sources (063) / platform_source_tiers (064).

create table if not exists public.search_coverage (
  id                 uuid primary key default gen_random_uuid(),
  keyword_norm       text not null,          -- lower(trim(keyword)), e.g. 'ain'
  location_cell      text not null,          -- normaliseCity() output, e.g. 'melbourne' ('' = all-AU)
  source             text not null,          -- 'seek' | 'adzuna' | 'careerjet'
  last_refreshed_at  timestamptz not null,   -- newest successful scrape of this slice
  covered_through    timestamptz not null,   -- oldest posted_at we have backfilled to
  last_job_count     int not null default 0, -- run-level jobs-fetched signal (coarse, v1)
  refreshing         boolean not null default false,  -- single-flight lock (Phase C)
  refresh_started_at timestamptz,                     -- lock staleness guard (Phase C)
  updated_at         timestamptz not null default now(),
  unique (keyword_norm, location_cell, source)
);

-- The unique constraint already provides a btree on (keyword_norm, location_cell,
-- source) which serves lookups by the leading subset (keyword_norm, or
-- keyword_norm+location_cell). No extra index needed for v1.

-- Keep updated_at honest on every UPDATE (refreshing / last_refreshed_at mutate
-- repeatedly) — reuse the shared trigger function from 001_schema.sql.
create trigger search_coverage_set_updated_at
  before update on public.search_coverage
  for each row execute function public.set_updated_at();

alter table public.search_coverage enable row level security;

-- Service-role only — backend/worker reads/writes this freshness ledger with
-- the service-role client. No end-user client touches it.
create policy "service role full access" on public.search_coverage
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
