-- Migration 064 — subscription-tier job-source config.
--
-- Migration 063's platform_sources was a single global row applied to every
-- user. We now vary source method BY THE USER'S SUBSCRIPTION TIER:
--   weekly/monthly (free tiers) → adzuna=api, seek=direct, careerjet=api.
--   unlimited (premium)        → adzuna=direct (full JDs via Apify actor),
--                                 seek=direct, careerjet=api.
-- seek=direct already falls back to the Apify actor on failure for every
-- tier (orchestrator.ts) — that fallback is not a per-tier setting.
--
-- platform_sources (migration 063) is left in place but no longer read by
-- the orchestrator once this migration's table is wired in.

create table if not exists public.platform_source_tiers (
  tier             text primary key check (tier in ('weekly', 'monthly', 'unlimited')),
  enabled_sources  text[] not null default '{adzuna,seek,careerjet}',
  adzuna_method    text not null default 'api' check (adzuna_method in ('api', 'direct')),
  seek_method      text not null default 'direct' check (seek_method in ('direct', 'actor')),
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users(id)
);

insert into public.platform_source_tiers (tier, enabled_sources, adzuna_method, seek_method) values
  ('weekly',    '{adzuna,seek,careerjet}', 'api',    'direct'),
  ('monthly',   '{adzuna,seek,careerjet}', 'api',    'direct'),
  ('unlimited', '{adzuna,seek,careerjet}', 'direct', 'direct')
on conflict (tier) do nothing;

alter table public.platform_source_tiers enable row level security;

-- Service-role only — same access pattern as platform_sources.
create policy "service role full access" on public.platform_source_tiers
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
