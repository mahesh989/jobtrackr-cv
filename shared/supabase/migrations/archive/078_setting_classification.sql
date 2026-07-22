-- Migration 078 — work-setting classification.
--
-- Adds a per-job WORK-SETTING label (where the care is physically delivered) and
-- a per-profile filter so users only surface jobs in the settings they want.
--
-- Taxonomy (4 categories, string keys — see backend/worker/src/ai/settingClassifier.ts):
--   'hospital_clinical'      hospitals, wards, day surgery, GP/clinics, dialysis…
--   'residential_aged_care'  nursing homes / RACF + retirement villages
--   'home_community'         care in the client's own home OR travelling between
--   'other'                  a care job we can't confidently pin (fail-open)
--   NULL                     not a care/health job → never classified, never filtered
--
-- ADDITIVE ONLY: three nullable columns on the two job tables (a shared fact,
-- computed once per posting on global_jobs, projected onto jobs) and one opt-in
-- array on search_profiles. No existing column/type/constraint is altered.
-- DORMANT until the worker's classification stage writes them and a profile sets
-- a non-empty setting_filter — creating the columns alone changes nothing.

-- ── global_jobs: the shared, once-per-posting classification (canonical) ──────
alter table public.global_jobs
  add column if not exists setting_category   text,
  add column if not exists setting_confidence real,
  add column if not exists setting_evidence   text;

-- ── jobs: the per-profile projection (copied from the bucket at serve time) ───
alter table public.jobs
  add column if not exists setting_category   text,
  add column if not exists setting_confidence real,
  add column if not exists setting_evidence   text;

-- ── search_profiles: the user's opt-in setting filter ────────────────────────
-- Empty array '{}' = no filtering (opt-in, mirrors how working_rights defaults
-- to unfiltered). A non-empty array keeps only jobs whose setting_category is a
-- member; NULL/'other' rows are fail-open (surfaced, never dropped — see
-- pipeline/settingFilter.ts).
alter table public.search_profiles
  add column if not exists setting_filter text[] not null default '{}';

-- Partial index: only profiles that actually opted in pay for the index, and
-- serve-time filtering on jobs.setting_category stays cheap for care verticals.
create index if not exists idx_jobs_profile_setting
  on public.jobs (profile_id, setting_category)
  where setting_category is not null;
