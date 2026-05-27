-- Per-profile Adzuna fetch method — mirrors the existing seek_method toggle.
--
-- 'api'    → default. Use the Adzuna API teaser only (~600 char description,
--            no extra HTTP calls in stage 7d). Fast, lean, free.
-- 'direct' → opt-in. After the API listings, scrape each /details/<id> HTML
--            page via curl_cffi (Chrome 124 TLS) for the full ~8000+ char JD.
--            Adds ~2-5 min to the run; worker is on BullMQ so user UI is
--            unaffected. JD-enrichment cap raised to 50 in this mode.

alter table public.search_profiles
  add column if not exists adzuna_method text default 'api'
  check (adzuna_method in ('api', 'direct'));

comment on column public.search_profiles.adzuna_method is
  'Adzuna fetch strategy. ''api'' = API teasers only (fast). ''direct'' = also scrape /details/<id> HTML for full JDs (slow, opt-in). Mirrors seek_method.';
