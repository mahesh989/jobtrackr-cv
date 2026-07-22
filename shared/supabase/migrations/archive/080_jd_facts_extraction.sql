-- ============================================================
-- Migration 080: JD facts extraction (employment type, emails,
--                working-rights requirement, salary period,
--                closing date, shifts, agency flag)
--
-- All job-property columns land on BOTH public.jobs (per-profile
-- materialisation) and public.global_jobs (shared canonical bucket),
-- mirroring how visa/setting facts are stored (067/078 precedent).
-- The worker's extractors (ai/jdFacts.ts, ai/visaExtractor.ts)
-- populate them at scrape time; bucket.ts projects them at serve.
--
-- employment_types:        canonical tags {full_time, part_time, casual,
--                          contract, temporary, internship}; a JD may carry
--                          several ("Full-time or Part-time"). NULL = not
--                          yet extracted; '{}' = extracted, nothing stated.
-- employment_source:       provenance — 'structured' (source metadata,
--                          authoritative) | 'regex' (JD text).
-- work_rights_requirement: what the JD demands TODAY — orthogonal to
--                          sponsorship_status (which is about the future):
--                          citizen_only | pr_citizen | full_unrestricted |
--                          any_valid | not_stated.
-- extracted_emails:        [{email, kind: application|enquiry|other,
--                          person, context}] found in the JD. jobs.contact_email
--                          stays the single manual/automation address; a
--                          separate guarded UPDATE autofills it from a
--                          high-confidence application email ONLY when null.
-- salary_period:           unit for the EXISTING salary_min/salary_max
--                          columns when extracted from JD text —
--                          hour|day|week|fortnight|year. NULL for
--                          source-structured salaries (Adzuna = annual).
-- closing_date:            "applications close …" parsed to a date.
-- shift_patterns:          healthcare shift tags {morning, afternoon, night,
--                          weekend, sleepover, on_call, rotating_roster,
--                          split_shifts}.
-- is_agency:               TRUE = confidently a recruiter posting
--                          ("our client…", known AU agencies). NULL = unknown
--                          (never claims false).
--
-- search_profiles.employment_filter: per-profile serve-time filter —
--                          keep only jobs whose employment_types intersect;
--                          '{}' = no filtering (opt-in), matching the
--                          setting_filter convention from 078.
--
-- All additive, nullable (or defaulted '{}'), metadata-only — no table
-- rewrite, no trigger/RLS/view interaction (verified pre-flight).
-- ============================================================

alter table public.jobs
  add column if not exists employment_types        text[],
  add column if not exists employment_source       text
    check (employment_source in ('structured','regex') or employment_source is null),
  add column if not exists work_rights_requirement text
    check (work_rights_requirement in
      ('citizen_only','pr_citizen','full_unrestricted','any_valid','not_stated')
      or work_rights_requirement is null),
  add column if not exists extracted_emails        jsonb,
  add column if not exists salary_period           text
    check (salary_period in ('hour','day','week','fortnight','year') or salary_period is null),
  add column if not exists closing_date            date,
  add column if not exists shift_patterns          text[],
  add column if not exists is_agency               boolean;

alter table public.global_jobs
  add column if not exists employment_types        text[],
  add column if not exists employment_source       text
    check (employment_source in ('structured','regex') or employment_source is null),
  add column if not exists work_rights_requirement text
    check (work_rights_requirement in
      ('citizen_only','pr_citizen','full_unrestricted','any_valid','not_stated')
      or work_rights_requirement is null),
  add column if not exists extracted_emails        jsonb,
  add column if not exists salary_period           text
    check (salary_period in ('hour','day','week','fortnight','year') or salary_period is null),
  add column if not exists closing_date            date,
  add column if not exists shift_patterns          text[],
  add column if not exists is_agency               boolean;

alter table public.search_profiles
  add column if not exists employment_filter text[] not null default '{}';

comment on column public.jobs.employment_types is
  'Canonical work-type tags extracted at scrape (full_time/part_time/casual/contract/temporary/internship). NULL = not extracted; {} = nothing stated.';
comment on column public.jobs.work_rights_requirement is
  'What the JD requires the applicant to hold TODAY. Orthogonal to sponsorship_status (future sponsorship).';
comment on column public.jobs.extracted_emails is
  'Emails found in the JD: [{email, kind: application|enquiry|other, person, context}]. contact_email autofills from the first application-kind entry only when null.';
comment on column public.jobs.salary_period is
  'Unit for salary_min/salary_max when regex-extracted from JD text. NULL for source-structured (annual) salaries.';
comment on column public.search_profiles.employment_filter is
  'Serve-time employment-type filter: keep jobs whose employment_types intersect. {} = no filtering (078 setting_filter convention).';
