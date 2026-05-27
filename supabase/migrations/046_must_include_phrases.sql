-- Per-profile "must-include" smart filter — promoted from the beta source-eval tool.
--
-- A job passes the keyword filter if its TITLE contains at least one of these
-- phrases (case-insensitive, word-boundary matching for single words, exact
-- substring OR all-words for multi-word phrases — same rules as the beta).
--
-- When the array is empty (default), the worker falls back to filtering by
-- `profile.keywords` instead. So existing profiles keep working without any
-- backfill: their search keywords double as the filter list.
--
-- A non-empty array also activates the "teaser rescue" pass — title-rejects
-- get one more chance via a first-500-char description scan, recovering legit
-- role variants (e.g. "Business Analyst (Data & Reporting)" rescued when the
-- list contains "Data Analyst").
--
-- Mirrors the pattern of exclude_title_keywords (migration 007).

alter table public.search_profiles
  add column if not exists must_include_phrases text[] default '{}';

comment on column public.search_profiles.must_include_phrases is
  'Optional comma-separated phrases for the "smart filter — must include any of" UX. Title-only match. Empty array = use profile.keywords for filtering. Promoted from the beta source-eval tool.';
