-- Migration 041: per-profile source selection + SEEK fetch method
--
-- enabled_sources: which source adapters to run for this profile. NULL or empty
--   means "all active sources" (backward-compatible with existing profiles).
--   Values are adapter names: 'adzuna', 'careerjet', 'greenhouse', 'lever', 'seek', …
-- seek_method: how SEEK is fetched — 'direct' (free curl_cffi scrape, default)
--   or 'actor' (Apify actor, ~$0.42/run, uses the user's Apify integration).

alter table public.search_profiles
  add column if not exists enabled_sources text[],
  add column if not exists seek_method text not null default 'direct'
    check (seek_method in ('direct', 'actor'));

comment on column public.search_profiles.enabled_sources is
  'Adapter names to run for this profile (e.g. {adzuna,seek,greenhouse}). '
  'NULL/empty = all active sources.';
comment on column public.search_profiles.seek_method is
  'SEEK fetch method: direct (free curl_cffi) or actor (Apify, paid).';
