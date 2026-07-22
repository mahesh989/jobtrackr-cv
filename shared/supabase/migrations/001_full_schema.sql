-- ============================================================
-- JobTrackr — 001_full_schema.sql (squashed 2026-07-23)
--
-- Consolidation of migrations 001–082 (84 files, now under ./archive/).
-- Applying this file + 002_rls.sql + 003_seed.sql to a fresh database
-- produces the exact same schema as applying the 84 originals in order.
--
-- Column order inside each CREATE TABLE deliberately mirrors the order
-- the columns reached the live table (base columns first, then each
-- ALTER TABLE ADD COLUMN in migration order) so pg_dump output is
-- byte-comparable between the two paths.
--
-- Historical one-off backfill UPDATEs (032, 038§3, 041§1, 050, 060 BYOK
-- carry-over, 051 beta grandfathering, 079 engagement backfill) are NOT
-- reproduced here — they operated on production data and are no-ops or
-- meaningless on a fresh database. See ./archive/ for the full history.
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
  created_at       timestamptz not null default now(),
  -- 049: sidebar Applications badge "last viewed" watermark
  applications_seen_at timestamptz
);

comment on column public.users.applications_seen_at is
  'When the user last opened the Applications outbox. The sidebar badge counts only pool items whose cover letter completed after this time. NULL = never visited.';

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

-- Auto-update updated_at (shared by every table with an updated_at column)
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
-- SEARCH PROFILES
-- Base (001) + 006 target_verticals + 007 adzuna knobs + 031 automation
-- (minus min_initial_ats / min_final_ats, dropped by 041) + 041 source
-- selection + 046 must_include_phrases + 047 adzuna_method + 048 home
-- origin + 054 is_manual + 078 setting_filter + 080 employment_filter.
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
  updated_at       timestamptz not null default now(),
  -- 006: per-profile vertical filter
  target_verticals text[] not null default '{"general", "tech", "healthcare"}',
  -- 007: Adzuna advanced search knobs
  adzuna_title_keywords text default '',
  adzuna_exact_phrase text default '',
  adzuna_any_keywords text default '',
  adzuna_exclude_keywords text default '',
  adzuna_salary_min int default null,
  adzuna_salary_max int default null,
  adzuna_contract_type text default null check (adzuna_contract_type in ('permanent', 'contract', null)),
  adzuna_hours text default null check (adzuna_hours in ('full_time', 'part_time', null)),
  adzuna_distance_km int default 25,
  adzuna_max_days_old int default 14,
  exclude_title_keywords text[] default '{}',
  -- 031: per-profile automation config (min_initial_ats / min_final_ats
  -- were added here too but dropped by 041 — thresholds are global now)
  automation_enabled      boolean NOT NULL DEFAULT false,
  role_match_strict       boolean NOT NULL DEFAULT false,
  auto_send_emails        text    NOT NULL DEFAULT 'never'
    CHECK (auto_send_emails IN ('never', 'after_review', 'auto')),
  daily_application_limit int     NOT NULL DEFAULT 10
    CHECK (daily_application_limit >= 0),
  -- 041: per-profile source selection + SEEK fetch method
  enabled_sources text[],
  seek_method text not null default 'direct'
    check (seek_method in ('direct', 'actor')),
  -- 046: "must-include" smart filter phrases
  must_include_phrases text[] default '{}',
  -- 047: Adzuna fetch method
  adzuna_method text default 'api'
    check (adzuna_method in ('api', 'direct')),
  -- 048: home origin for driving distances
  home_address text,
  home_lat numeric(9,6),
  home_lng numeric(9,6),
  -- 054: per-user "Saved Jobs" manual profile flag
  is_manual boolean not null default false,
  -- 078: opt-in work-setting filter
  setting_filter text[] not null default '{}',
  -- 080: opt-in employment-type filter
  employment_filter text[] not null default '{}'
);

create index idx_search_profiles_user_id on public.search_profiles(user_id);

create trigger search_profiles_updated_at
  before update on public.search_profiles
  for each row execute function public.set_updated_at();

comment on column public.search_profiles.enabled_sources is
  'Adapter names to run for this profile (e.g. {adzuna,seek,greenhouse}). '
  'NULL/empty = all active sources.';
comment on column public.search_profiles.seek_method is
  'SEEK fetch method: direct (free curl_cffi) or actor (Apify, paid).';
comment on column public.search_profiles.must_include_phrases is
  'Optional comma-separated phrases for the "smart filter — must include any of" UX. Title-only match. Empty array = use profile.keywords for filtering. Promoted from the beta source-eval tool.';
comment on column public.search_profiles.adzuna_method is
  'Adzuna fetch strategy. ''api'' = API teasers only (fast). ''direct'' = also scrape /details/<id> HTML for full JDs (slow, opt-in). Mirrors seek_method.';
comment on column public.search_profiles.home_address is
  'User''s free-text home/work address. Distances from this point are shown on the job board. Leave empty to hide distance UI for this profile.';
comment on column public.search_profiles.home_lat is
  'Latitude of home_address, geocoded by the worker via Nominatim. Reset to NULL when home_address changes so the worker re-geocodes.';
comment on column public.search_profiles.home_lng is
  'Longitude of home_address, geocoded by the worker via Nominatim.';
comment on column public.search_profiles.is_manual is
  'True for the per-user "Saved Jobs" profile. Never fetched by the worker. '
  'Auto-provisioned on first Add Job action. Non-deletable from the UI.';
comment on column public.search_profiles.employment_filter is
  'Serve-time employment-type filter: keep jobs whose employment_types intersect. {} = no filtering (078 setting_filter convention).';

-- 054: fast lookup of the manual profile
create index if not exists idx_search_profiles_manual
  on public.search_profiles(user_id)
  where is_manual = true;

-- ============================================================
-- JOBS
-- Base (001) + 009 possible_duplicate dedup status + 005 salary +
-- 015 manual JD/contact + 026 hiring_manager + 027 company_address +
-- 031 pre-check signals + 033 pool decision + 048 distance +
-- 053 starred + 078 work-setting + 080 JD facts.
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
                      check (dedup_status in ('original', 'duplicate', 'repost', 'possible_duplicate')),
  duplicate_of      uuid references public.jobs on delete set null,
  repost_of         uuid references public.jobs on delete set null,
  ai_relevance_score float,                             -- 0-1, null until AI scored
  visa_likelihood   float,                              -- 0-1, null until AI scored
  keywords_matched  text[] not null default '{}',
  seen_at           timestamptz,                        -- when user first viewed
  applied_at        timestamptz,                        -- when user marked applied
  dismissed_at      timestamptz,                        -- when user dismissed
  created_at        timestamptz not null default now(),
  -- 005: salary range
  salary_min numeric,
  salary_max numeric,
  -- 015: per-job manual JD override + contact email
  manual_jd_text text,
  contact_email  text,
  -- 026: cover-letter salutation personalisation
  hiring_manager text,
  -- 027: cover-letter employer block
  company_address text,
  -- 031: pre-check signals + generated has_email flag
  jd_quality  text CHECK (jd_quality IN ('rich', 'thin', 'unknown')),
  role_match  text CHECK (role_match IN ('match', 'mismatch', 'uncertain')),
  has_email   boolean GENERATED ALWAYS AS (contact_email IS NOT NULL) STORED,
  -- 033: applications pool decision tracking
  pool_decision_at timestamptz DEFAULT NULL,
  -- 048: driving-distance metadata
  distance_km numeric(8,2),
  distance_method text
    check (distance_method in ('driving', 'haversine')),
  -- 053: favourites/shortlist
  starred_at timestamptz,
  -- 078: work-setting classification (per-profile projection)
  setting_category   text,
  setting_confidence real,
  setting_evidence   text,
  -- 080: JD facts extraction
  employment_types        text[],
  employment_source       text
    check (employment_source in ('structured','regex') or employment_source is null),
  work_rights_requirement text
    check (work_rights_requirement in
      ('citizen_only','pr_citizen','full_unrestricted','any_valid','not_stated')
      or work_rights_requirement is null),
  extracted_emails        jsonb,
  salary_period           text
    check (salary_period in ('hour','day','week','fortnight','year') or salary_period is null),
  closing_date            date,
  shift_patterns          text[],
  is_agency               boolean,

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
-- 053: partial index over starred rows only
create index if not exists idx_jobs_starred
  on public.jobs(profile_id, starred_at desc)
  where starred_at is not null;
-- 078: partial index for setting-filter serves
create index if not exists idx_jobs_profile_setting
  on public.jobs (profile_id, setting_category)
  where setting_category is not null;

comment on column public.jobs.manual_jd_text is
  'User-edited JD text. When set, /api/jobs/[id]/analyze prefers this over jobs.description so the AI receives a denoised input.';
comment on column public.jobs.contact_email is
  'Optional recruiter contact for a future MCP email-send flow.';
comment on column public.jobs.hiring_manager is
  'Name of the hiring manager for this role. Used in cover letter salutation (e.g., "Dear John Smith,"). If NULL, salutation defaults to "Dear Hiring Manager,".';
comment on column public.jobs.company_address is
  'Street/postal address of the employer, multi-line. Used in the cover letter '
  'employer block between company name and city/state. NULL = omit.';
comment on column public.jobs.distance_km is
  'Driving distance from the profile''s home_address in km. NULL if the job location could not be geocoded or the profile has no home address.';
comment on column public.jobs.distance_method is
  '''driving'' = OSRM route. ''haversine'' = straight-line fallback when OSRM returned no route.';
comment on column public.jobs.starred_at is
  'When the user starred this job (NULL = not starred). Used for the favourites filter chip.';
comment on column public.jobs.employment_types is
  'Canonical work-type tags extracted at scrape (full_time/part_time/casual/contract/temporary/internship). NULL = not extracted; {} = nothing stated.';
comment on column public.jobs.work_rights_requirement is
  'What the JD requires the applicant to hold TODAY. Orthogonal to sponsorship_status (future sponsorship).';
comment on column public.jobs.extracted_emails is
  'Emails found in the JD: [{email, kind: application|enquiry|other, person, context}]. contact_email autofills from the first application-kind entry only when null.';
comment on column public.jobs.salary_period is
  'Unit for salary_min/salary_max when regex-extracted from JD text. NULL for source-structured (annual) salaries.';

-- ── 038/050/062: jd_quality auto-classification ─────────────────────────────
-- Single source of truth for jd_quality. Threshold history: 2000 (038) →
-- 1400 (050) → 1000 (062, current — matches MANUAL_JD_MIN_CHARS in web
-- jobFilters.ts). If you change the threshold here, also bump JD_MIN_USABLE
-- in worker/src/automation/triggerAutoAnalyze.ts.
CREATE OR REPLACE FUNCTION public.classify_jd_quality(description text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN length(coalesce(description, '')) < 1000 THEN 'thin'
    WHEN description ILIKE '%responsibilit%'
      OR description ILIKE '%requirement%'
      OR description ILIKE '%qualification%'
      OR description ILIKE '%experience%'
      OR description ILIKE '%what you%'
      OR description ILIKE '%about the role%' THEN 'rich'
    ELSE 'unknown'
  END;
$$;

CREATE OR REPLACE FUNCTION public.jobs_set_jd_quality()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Use manual_jd_text when present (user pasted full JD) — otherwise the
  -- scraped description field. manual_jd_text wins because Phase E-1 and
  -- the analyze route both honour it as a richer signal.
  NEW.jd_quality := public.classify_jd_quality(
    coalesce(NULLIF(NEW.manual_jd_text, ''), NEW.description)
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER jobs_jd_quality_trigger
  BEFORE INSERT OR UPDATE OF description, manual_jd_text ON public.jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.jobs_set_jd_quality();

-- ============================================================
-- RUN LOGS
-- Base (001) + 004 AI usage + 028 current_stage + 029 sources_saved +
-- 030 log_lines + 040 jobs_deduped + 065 source_methods.
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
  created_at       timestamptz not null default now(),
  -- 004: AI usage tracking
  ai_tokens_input  int not null default 0,
  ai_tokens_output int not null default 0,
  ai_cost_cents    int not null default 0,  -- USD cents × 100 (millicents)
  ai_batch_id      text,                    -- Anthropic batch ID if async
  -- 028: live progress signal
  current_stage text,
  -- 029: per-source breakdown of jobs saved
  sources_saved jsonb,
  -- 030: append-only log stream
  log_lines jsonb not null default '[]'::jsonb,
  -- 040: dedup-specific drop count
  jobs_deduped integer DEFAULT 0,
  -- 065: per-run source-method tracking
  source_methods jsonb
);

create index idx_run_logs_profile_id on public.run_logs(profile_id, started_at desc);

comment on column public.run_logs.current_stage is
  'Human-readable label of the stage the pipeline is currently in. '
  'Updated mid-run by the worker for live UI progress. NULL once the run terminates.';
comment on column public.run_logs.sources_saved is
  'Per-source count of jobs saved in this run, e.g. {"adzuna":5,"seek":8}. '
  'NULL on pre-feature rows or runs that failed before stage 12.';
comment on column public.run_logs.log_lines is
  'Append-only array of {t, msg} entries captured from worker console output '
  'during the run. Powers the live "scrolling console" UI on the jobs/runs pages.';

-- 004: monthly AI spend helper (cost cap enforcement in the worker)
create or replace function public.monthly_ai_spend_millicents(p_user_id uuid)
returns int
language sql stable
as $$
  select coalesce(sum(rl.ai_cost_cents), 0)::int
  from   public.run_logs rl
  join   public.search_profiles sp on sp.id = rl.profile_id
  where  sp.user_id = p_user_id
    and  rl.started_at >= date_trunc('month', now());
$$;

-- 030: atomic single-line log append (avoids lost-update races)
create or replace function public.append_run_log_line(rid uuid, line jsonb)
returns void
language sql
as $$
  update public.run_logs
  set log_lines = coalesce(log_lines, '[]'::jsonb) || jsonb_build_array(line)
  where id = rid;
$$;

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

-- ============================================================
-- USER INTEGRATIONS (008)
-- Stores per-user third-party integration credentials (Apify today).
-- Credentials are encrypted at the application layer (AES-256-GCM);
-- the raw token never appears in this table. chk_provider reflects the
-- final allow-list (008 → 012 → 014). The anthropic/openai/deepseek BYOK
-- rows this table once held were migrated into platform_ai_settings and
-- deleted by migration 060.
-- ============================================================
create table public.user_integrations (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references public.users(id) on delete cascade,

  -- Which third-party service: 'apify', 'linkedin', 'indeed', …
  provider            text        not null,

  -- AES-256-GCM encrypted blob. Format: base64(iv[16] || authTag[16] || ciphertext).
  encrypted_api_key   text        not null,

  -- pending_validation | valid | invalid | expired | revoked |
  -- quota_exceeded | disabled
  status              text        not null default 'pending_validation'
                        check (status in (
                          'pending_validation','valid','invalid',
                          'expired','revoked','quota_exceeded','disabled'
                        )),
  status_reason       text,               -- human-readable reason, shown in UI
  last_validated_at   timestamptz,        -- when we last confirmed it worked
  last_used_at        timestamptz,        -- when a pipeline last used it

  -- Quota tracking (dollar-based and request-based pricing models)
  quota_used_usd      numeric(10,6) not null default 0,
  quota_used_requests integer       not null default 0,
  quota_period_start  date          not null
                        default date_trunc('month', current_date)::date,

  -- Provider-specific non-sensitive config
  config              jsonb         not null default '{}',

  is_enabled          boolean       not null default true,

  created_at          timestamptz   not null default now(),
  updated_at          timestamptz   not null default now(),

  -- One active credential per provider per user
  constraint uq_user_provider unique (user_id, provider),

  -- Known providers — final allow-list after 012 (+anthropic/openai) and
  -- 014 (+deepseek)
  constraint chk_provider check (provider in ('apify', 'linkedin', 'indeed', 'anthropic', 'openai', 'deepseek'))
);

create index idx_user_integrations_user_id on public.user_integrations(user_id);
create index idx_user_integrations_provider on public.user_integrations(provider);
create index idx_user_integrations_status  on public.user_integrations(status);

create trigger user_integrations_updated_at
  before update on public.user_integrations
  for each row execute function public.set_updated_at();

-- Admin view (service-role only; encrypted_api_key deliberately excluded)
create view public.admin_integrations_overview as
select
  au.email,
  ui.id                as integration_id,
  ui.provider,
  ui.status,
  ui.status_reason,
  ui.last_validated_at,
  ui.last_used_at,
  ui.quota_used_usd,
  ui.quota_used_requests,
  ui.quota_period_start,
  ui.is_enabled,
  ui.config,
  ui.created_at,
  count(distinct sp.id)  as profile_count,
  max(rl.started_at)     as last_pipeline_run,
  count(case when rl.status = 'completed'
             and rl.started_at > now() - interval '7 days'
        then 1 end)      as successful_runs_last_7d,
  count(case when rl.status = 'failed'
             and rl.started_at > now() - interval '24 hours'
        then 1 end)      as failures_last_24h
from public.user_integrations ui
join public.users          au on au.id           = ui.user_id
left join public.search_profiles sp on sp.user_id = ui.user_id
left join public.run_logs        rl on rl.profile_id = sp.id
group by au.email, ui.id
order by ui.created_at desc;

-- ============================================================
-- CV VERSIONS (010)
-- + 016 categorised_skills + 056 extracted_references +
-- 058 structured_cv/status + 059 normalized_cv_text.
-- Exactly one row per user can have is_active = true (partial unique).
-- ============================================================
create table public.cv_versions (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references public.users(id) on delete cascade,

  label               text        not null,                -- e.g. "Master CV — 2026"
  pdf_storage_path    text        not null,                -- Supabase Storage path
  cv_text             text        not null,                -- pypdf extraction

  is_active           boolean     not null default false,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- 016: AI skill categorisation computed at upload
  categorised_skills jsonb,
  -- 056: per-CV cache of AI-extracted references
  extracted_references JSONB,
  -- 058: normalised, user-verifiable structured CV
  structured_cv        JSONB,
  structured_cv_status TEXT,
  -- 059: canonical CV text rendered from structured_cv
  normalized_cv_text TEXT
);

-- Exactly one active CV per user
create unique index uq_one_active_cv_per_user
  on public.cv_versions(user_id)
  where is_active = true;

create index idx_cv_versions_user_id on public.cv_versions(user_id);
create index idx_cv_versions_created_at on public.cv_versions(created_at desc);

create trigger cv_versions_updated_at
  before update on public.cv_versions
  for each row execute function public.set_updated_at();

comment on column public.cv_versions.categorised_skills is
  'AI-extracted categorised skill list from this CV. Populated at upload when an AI key is configured; null otherwise. Used for at-a-glance review and as a possible prefill for tailoring.';
comment on column public.cv_versions.extracted_references is
  'AI-extracted referee list from the original CV. NULL = not yet extracted. [] = extracted but none found.';
comment on column public.cv_versions.structured_cv is
  'Normalised, user-verifiable structured CV — the analysis source of truth. NULL = not yet parsed. See app/services/cv/cv_structurizer.py for the schema.';
comment on column public.cv_versions.structured_cv_status is
  'parsed | edited | verified — NULL for legacy CVs predating the structured-CV feature.';
comment on column public.cv_versions.normalized_cv_text is
  'Canonical CV markdown rendered from structured_cv on every save. Source of truth for analysis. NULL = not yet structured (legacy or pre-review).';

-- ============================================================
-- ANALYSIS RUNS (011)
-- cv_version_id FK is ON DELETE CASCADE (017). + 018 provenance +
-- 031 gate columns + 042 cover_letter_status + 057 quality_flags.
-- ============================================================
create table public.analysis_runs (
  id                          uuid        primary key default gen_random_uuid(),
  user_id                     uuid        not null references public.users(id) on delete cascade,
  job_id                      uuid        not null references public.jobs(id)   on delete cascade,
  cv_version_id               uuid        not null references public.cv_versions(id) on delete cascade,

  -- pending | running | completed | failed
  status                      text        not null default 'pending'
                                check (status in ('pending','running','completed','failed')),

  -- Per-step status — 7 pipeline steps. Frontend reads this JSON and
  -- animates the step cards.
  step_status                 jsonb       not null default jsonb_build_object(
                                'jd_analysis',           'pending',
                                'cv_jd_matching',        'pending',
                                'ats_scoring',           'pending',
                                'input_recommendations', 'pending',
                                'keyword_feasibility',   'pending',
                                'ai_recommendations',    'pending',
                                'tailored_cv',           'pending'
                              ),

  -- The exact JD text that fed the pipeline
  jd_text                     text        not null,

  -- Step results
  jd_analysis_result          jsonb,
  cv_jd_matching_result       jsonb,
  ats_scoring_result          jsonb,
  input_recommendations       jsonb,
  keyword_feasibility         jsonb,
  ai_recommendations          text,                       -- markdown

  -- Step 6 outputs
  tailored_cv_storage_path    text,                       -- markdown in Storage
  tailored_pdf_storage_path   text,                       -- ReportLab-rendered PDF
  tailored_ats_scoring_result jsonb,
  injected_keywords           jsonb,

  -- Scores (denormalised for fast filtering on the job board)
  match_score                 integer,
  tailored_match_score        integer,
  ats_lift                    integer,

  -- Lifecycle
  is_stale                    boolean     not null default false,
  error_message               text,

  started_at                  timestamptz,
  completed_at                timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  -- 018: AI provenance
  ai_provider text,
  ai_model    text,
  -- 031: two-gate model + automation flag
  initial_ats_score    numeric,
  passed_initial_gate  boolean,
  passed_final_gate    boolean,
  automation           boolean NOT NULL DEFAULT false,
  -- 042: auto-cover-letter outcome
  cover_letter_status text,
  -- 057: honesty-guard rewrite notes
  quality_flags JSONB
);

create index idx_analysis_runs_user_id on public.analysis_runs(user_id);
create index idx_analysis_runs_job_id  on public.analysis_runs(job_id);
create index idx_analysis_runs_user_job on public.analysis_runs(user_id, job_id);
create index idx_analysis_runs_status  on public.analysis_runs(status);
-- Fast lookup of "current (non-stale) run for this job"
create index idx_analysis_runs_active
  on public.analysis_runs(user_id, job_id, created_at desc)
  where is_stale = false;

create trigger analysis_runs_updated_at
  before update on public.analysis_runs
  for each row execute function public.set_updated_at();

comment on column public.analysis_runs.ai_provider is
  'AI provider used for this run: anthropic | openai | deepseek';
comment on column public.analysis_runs.ai_model is
  'Exact model ID sent to the provider (e.g. ''gpt-5.2'', ''claude-sonnet-4-6'').';
comment on column public.analysis_runs.cover_letter_status is
  'Outcome of the auto-cover-letter step. NULL = not attempted. See migration 040 for the value domain.';
comment on column public.analysis_runs.quality_flags is
  'Honesty-guard rewrite notes from w8_verified tailoring. NULL = legacy path or no run. [] = w8 ran with no rewrites. [..] = list of human-readable adjustments.';

-- ============================================================
-- USER PREFERENCES (020)
-- ============================================================
create table public.user_preferences (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null unique references public.users(id) on delete cascade,
  contact_details jsonb,                            -- nullable; empty = nothing to stamp
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger user_preferences_updated_at
  before update on public.user_preferences
  for each row execute function public.set_updated_at();

-- ============================================================
-- VOICE PROFILES (021)
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

create trigger voice_profiles_updated_at
  before update on public.voice_profiles
  for each row execute function public.set_updated_at();

-- ============================================================
-- STORIES (022) + replace_stories RPC (023)
-- ============================================================
create table public.stories (
  id                   uuid        primary key default gen_random_uuid(),
  user_id              uuid        not null references public.users(id) on delete cascade,
  title                text        not null,
  domain               text        not null,
  year                 integer,
  one_line             text        not null,
  detailed             text        not null,
  numbers              jsonb       not null default '[]'::jsonb,
  tags                 text[]      not null default '{}',
  extraction_timestamp timestamptz not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index stories_user_id_extraction_ts_idx
  on public.stories (user_id, extraction_timestamp desc);

create trigger stories_updated_at
  before update on public.stories
  for each row execute function public.set_updated_at();

-- Atomic replace of the user's story batch (delete + insert in one txn)
create or replace function public.replace_stories(
  p_user_id uuid,
  p_rows    jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Step 1: delete the entire current batch for this user.
  -- On failure the transaction rolls back and no data is lost.
  delete from public.stories
  where user_id = p_user_id;

  -- Step 2: insert the new batch.
  -- id, created_at, updated_at are omitted — they default via gen_random_uuid()
  -- and now(). user_id is supplied explicitly for every row.
  -- numbers and tags fall back to their NOT NULL defaults when the JSON field
  -- is absent or non-array (defensive; cv-backend always provides both).
  insert into public.stories (
    user_id,
    title,
    domain,
    year,
    one_line,
    detailed,
    numbers,
    tags,
    extraction_timestamp
  )
  select
    p_user_id,
    (elem->>'title')::text,
    (elem->>'domain')::text,
    (elem->>'year')::integer,
    (elem->>'one_line')::text,
    (elem->>'detailed')::text,
    case
      when jsonb_typeof(elem->'numbers') = 'array' then elem->'numbers'
      else '[]'::jsonb
    end,
    case
      when jsonb_typeof(elem->'tags') = 'array'
      then array(select jsonb_array_elements_text(elem->'tags'))
      else '{}'::text[]
    end,
    (elem->>'extraction_timestamp')::timestamptz
  from jsonb_array_elements(p_rows) as elem;
end;
$$;

revoke execute on function public.replace_stories(uuid, jsonb) from public;
grant  execute on function public.replace_stories(uuid, jsonb) to service_role;

-- ============================================================
-- COMPANY RESEARCH (024) — global shared cache, one row per company
-- ============================================================
CREATE TABLE public.company_research (
  company_id             text        PRIMARY KEY,           -- normalised slug, e.g. 'jll_australia'
  name                   text        NOT NULL,              -- display name as provided at trigger time
  domain                 text,                              -- nullable; discovered during first research
  facts                  jsonb       NOT NULL,              -- CompanyFacts object
  voice_signals          jsonb       NOT NULL,              -- VoiceSignals object
  hiring_intel           jsonb       NOT NULL,              -- HiringIntel object
  research_quality_score float       NOT NULL DEFAULT 0.0, -- deterministic 0.0–1.0; see quality_scorer.py
  search_skipped         boolean     NOT NULL DEFAULT false,-- true when TAVILY_API_KEY absent/failed
  last_researched_at     timestamptz NOT NULL,
  research_ttl_days      int         NOT NULL DEFAULT 90,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX company_research_last_researched_idx
  ON public.company_research(last_researched_at);

CREATE INDEX company_research_domain_idx
  ON public.company_research(domain)
  WHERE domain IS NOT NULL;

CREATE TRIGGER company_research_updated_at
  BEFORE UPDATE ON public.company_research
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- COVER LETTERS (025)
-- status CHECK includes 'picking' (027). + 027 variant columns +
-- 031 auto_selected_variant_id + 034 email send tracking +
-- 036 pdf_storage_path + 037 analysis_run_id + 039 review-then-send.
-- ============================================================
CREATE TABLE public.cover_letters (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid        NOT NULL REFERENCES public.users(id)  ON DELETE CASCADE,
  job_id                    uuid        NOT NULL REFERENCES public.jobs(id)   ON DELETE CASCADE,

  -- pending | running | completed | failed | picking (027)
  status                    text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'running', 'completed', 'failed', 'picking')),

  -- Fine-grained progress for the Realtime subscriber
  generation_status         jsonb       NOT NULL DEFAULT jsonb_build_object(
                              'pass_1', 'pending',
                              'pass_2', 'pending',
                              'pass_3', 'pending',
                              'gate_1', 'pending',
                              'gate_2', 'pending',
                              'gate_3', 'pending'
                            ),

  -- Generation inputs captured at trigger time
  story_id                  uuid        REFERENCES public.stories(id) ON DELETE SET NULL,
  company_hook_text         text,         -- selected company fact used as paragraph 1 opener
  tone_target               text        CHECK (tone_target IN ('professional', 'warm', 'direct')),
  word_count_target         int         NOT NULL DEFAULT 170,

  -- Pass outputs
  pass_1_skeleton           text,         -- populated after Pass 1 completes
  pass_2_voice_transferred  text,         -- populated after Pass 2 completes
  pass_3_final              text,         -- the deliverable shown to the user

  -- Quality gate scores
  burstiness_score          float,        -- stddev(sentence_lens)/mean; Gate 3 input
  naturalness_score         float,        -- burstiness normalised to [0,1] for UI badge
  coherence_score           float,        -- Gate 2 vocabulary overlap metric
  specificity_ok            boolean,      -- Gate 3: ≥1 concrete number/name/place in letter
  honesty_ok                boolean,      -- Gate 1: all claims traceable to master CV

  quality_flags             jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- AI provenance
  ai_provider               text        NOT NULL CHECK (ai_provider IN ('anthropic', 'openai', 'deepseek')),
  pass_1_model              text,
  pass_2_model              text,
  pass_3_model              text,

  -- User edit capture (Part 8 — feedback loop, deferred)
  user_edits                text,
  edit_diff                 jsonb,

  -- Outcome tracking (Part 8, deferred)
  outcome                   text        CHECK (outcome IN ('draft', 'sent', 'replied', 'interview', 'rejected', 'hired')),

  error_message             text,

  -- Lifecycle
  is_stale                  boolean     NOT NULL DEFAULT false,
  started_at                timestamptz,
  completed_at              timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  -- 027: opening-paragraph variant picker
  opening_variants   jsonb DEFAULT NULL,
  chosen_opening     text  DEFAULT NULL,
  discarded_openings jsonb DEFAULT NULL,
  -- 031: AI's auto-picked hook variant (analytics)
  auto_selected_variant_id text,
  -- 034: email send tracking
  email_sent_at  timestamptz,
  email_sent_to  text,
  -- 036: server-side PDF persistence ({user_id}/{letter_id}.pdf)
  pdf_storage_path text,
  -- 037: trace letter → analysis run
  analysis_run_id uuid
    REFERENCES analysis_runs(id) ON DELETE SET NULL,
  -- 039: review-then-send
  reviewed_at   timestamptz,
  email_subject text,
  email_body    text
);

CREATE INDEX cover_letters_user_job_idx
  ON public.cover_letters(user_id, job_id, created_at DESC)
  WHERE is_stale = false;

CREATE INDEX cover_letters_user_id_idx
  ON public.cover_letters(user_id);

CREATE INDEX cover_letters_status_idx
  ON public.cover_letters(status)
  WHERE status IN ('pending', 'running');

-- 037: letters-by-run lookup
CREATE INDEX IF NOT EXISTS cover_letters_analysis_run_idx
  ON cover_letters(analysis_run_id)
  WHERE analysis_run_id IS NOT NULL;

-- 039: bucket query for /dashboard/applications
CREATE INDEX IF NOT EXISTS cover_letters_user_status_reviewed_idx
  ON cover_letters (user_id, status, reviewed_at);

CREATE TRIGGER cover_letters_updated_at
  BEFORE UPDATE ON public.cover_letters
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON COLUMN cover_letters.reviewed_at IS
  'When the user clicked Approve in the compose modal. NULL = still in the Review stage; SET = ready to send. Cleared if the letter is regenerated or edited (so any revision goes back through review).';
COMMENT ON COLUMN cover_letters.email_subject IS
  'Subject line approved by the user during review. /send-email uses this if set, otherwise computes from buildDefaultEmailDraft.';
COMMENT ON COLUMN cover_letters.email_body IS
  'Email body approved by the user during review. /send-email uses this if set, otherwise computes from buildDefaultEmailDraft.';

-- ============================================================
-- APPLICATIONS (031) — the outbox
-- ============================================================
CREATE TABLE applications (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id          uuid        NOT NULL REFERENCES jobs(id)           ON DELETE CASCADE,
  analysis_run_id uuid                 REFERENCES analysis_runs(id)  ON DELETE SET NULL,
  cover_letter_id uuid                 REFERENCES cover_letters(id)  ON DELETE SET NULL,
  channel         text        NOT NULL CHECK (channel IN ('email', 'apply_link')),
  email_draft     text,
  email_subject   text,
  status          text        NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_review', 'queued', 'sent', 'failed', 'applied', 'archived')),
  sent_at         timestamptz,
  sent_to         text,
  error_message   text,
  user_verified   boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER applications_set_updated_at
  BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX applications_user_status_created_idx
  ON applications (user_id, status, created_at DESC);

CREATE INDEX applications_job_idx
  ON applications (job_id);

-- ============================================================
-- EMAIL INTEGRATIONS (031)
-- oauth_token is text (034 — AES-256-GCM base64, was bytea).
-- provider CHECK uses OAuth provider names (035 — was gmail/outlook).
-- ============================================================
CREATE TABLE email_integrations (
  user_id      uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  provider     text        CHECK (provider IN ('google', 'microsoft')),
  oauth_token  text,
  from_address text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER email_integrations_set_updated_at
  BEFORE UPDATE ON email_integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- EVAL RUNS (043; 044's status/error columns are already inline)
-- ============================================================
create table if not exists public.eval_runs (
  id                 uuid primary key default gen_random_uuid(),

  -- grouping / provenance
  experiment_id      text,           -- links A/B/C/D outputs for the same JD+CV
  jd_label           text,           -- human label e.g. "CAE Data Analyst"
  vertical           text,           -- it | nursing | cleaner | admin | master | other
  cv_source          text,           -- free-form: which CV was used (e.g. "mahesh", "wife-nursing")
  iteration          int  not null default 1,  -- improve-loop round number

  -- what produced this row
  writer_variant     text not null,  -- w1_current | w2_general | w3_composition | w4_chat
  scorer_variant     text not null,  -- s1_current | s2_grounded | s3_reweighted | s4_llm
  model              text,           -- resolved AI model id

  -- lifecycle (background pattern: row is created 'running', updated on finish)
  status             text not null default 'running',  -- running | completed | failed
  error              text,

  -- outputs
  tailored_md        text,
  initial_ats        int,
  final_ats          int,
  ats_lift           int,

  -- structured reports (deterministic)
  structural_summary jsonb,          -- run_tailored_structural_validation summary+gates
  grounding_report   jsonb,          -- Layer-A named-entity grounding (ungrounded list)
  rescore_report     jsonb,          -- injected / failed / fabricated keywords
  auto_metrics       jsonb,          -- any extra computed numbers
  timings_ms         jsonb,          -- per-stage latency

  created_at         timestamptz not null default now()
);

create index if not exists eval_runs_experiment_idx on public.eval_runs (experiment_id);
create index if not exists eval_runs_writer_idx     on public.eval_runs (writer_variant);
create index if not exists eval_runs_created_idx     on public.eval_runs (created_at desc);

-- ============================================================
-- SOURCE EVAL RUNS (045) — per-source dry-run pipeline metrics
-- ============================================================
CREATE TABLE IF NOT EXISTS public.source_eval_runs (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  keywords            text[]        NOT NULL,
  location            text,
  posted_within_days  integer       NOT NULL DEFAULT 14,
  sources_requested   text[]        NOT NULL,
  status              text          NOT NULL DEFAULT 'running'
                                    CHECK (status IN ('running', 'completed', 'failed')),
  results             jsonb         NOT NULL DEFAULT '{}'::jsonb,
  unique_total        integer,                  -- distinct URL count across all sources after filtering
  overlap             jsonb,                    -- {url_hash: [sources, ...]} — set on completion
  created_at          timestamptz   NOT NULL DEFAULT now(),
  finished_at         timestamptz
);

CREATE INDEX IF NOT EXISTS idx_source_eval_runs_user
  ON public.source_eval_runs(user_id, created_at DESC);

COMMENT ON TABLE public.source_eval_runs IS
  'Beta source-coverage eval: per-source dry-run pipeline metrics. Migration 045.';

-- ============================================================
-- BILLING (051) — Stripe subscriptions + usage metering
-- Plan-catalogue seed rows live in 003_seed.sql (final values incl. the
-- 082 weekly-cap restore + price fixes). The analysis_runs usage trigger
-- uses the gate-aware sync_usage_from_analysis_run() from 069.
-- ============================================================

-- ── PLANS ──────────────────────────────────────────────────
create table if not exists public.plans (
  id                 text primary key,          -- 'trial'|'weekly'|'monthly'|'unlimited'|'comp'
  display_name       text not null,
  stripe_price_id    text,                      -- null for trial/comp
  billing_interval   text check (billing_interval in ('day','week','month')),
  trial_days         int  not null default 0,

  -- NULL on any cap == unlimited for that dimension.
  max_profiles       int,
  max_runs           int,
  max_cv_unique      int,
  max_cv_total       int,
  max_letter_unique  int,
  max_letter_total   int,

  price_cents        int  not null default 0,   -- AUD cents
  currency           text not null default 'aud',
  sort_order         int  not null default 0,
  is_public          boolean not null default true,  -- shown on pricing page
  is_active          boolean not null default true
);

-- ── SUBSCRIPTIONS ──────────────────────────────────────────
-- One row per user. The webhook is the ONLY writer of paid status.
create table if not exists public.subscriptions (
  user_id                uuid primary key references public.users(id) on delete cascade,
  stripe_customer_id     text,
  stripe_subscription_id text,
  plan_id                text references public.plans(id),
  -- Stripe statuses + 'comp' (grandfathered, no Stripe sub).
  status                 text not null default 'incomplete'
                           check (status in ('trialing','active','past_due','canceled',
                                             'unpaid','incomplete','incomplete_expired','comp')),
  current_period_start   timestamptz,
  current_period_end     timestamptz,
  trial_end              timestamptz,
  cancel_at_period_end   boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists subscriptions_customer_idx     on public.subscriptions(stripe_customer_id);
create index if not exists subscriptions_subscription_idx on public.subscriptions(stripe_subscription_id);

-- ── USAGE EVENTS (reservation ledger) ──────────────────────
create table if not exists public.usage_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  kind          text not null check (kind in ('tailored_cv','cover_letter','run')),
  job_id        uuid references public.jobs(id) on delete set null,
  ref_id        uuid,                       -- analysis_runs.id / cover_letters.id (set after insert)
  status        text not null default 'pending'
                  check (status in ('pending','committed','voided')),
  period_start  timestamptz not null,       -- snapshot of the sub period at reserve time
  created_at    timestamptz not null default now()
);

-- The hot path: count active events per (user, kind, period).
create index if not exists usage_events_count_idx
  on public.usage_events(user_id, kind, status, period_start);
-- Trigger lookup by artifact id.
create index if not exists usage_events_ref_idx
  on public.usage_events(ref_id) where ref_id is not null;

-- ── STRIPE EVENT DEDUPE ────────────────────────────────────
create table if not exists public.stripe_events (
  event_id     text primary key,
  type         text,
  processed_at timestamptz not null default now()
);

-- ============================================================
-- consume_usage() — atomic cap-check + reservation
-- ============================================================
-- Returns (allowed boolean, reason text, event_id uuid).
-- Counts ACTIVE events = committed OR pending-within-1h (dangling pending
-- self-heals). A re-analysis of an already-counted job does NOT raise the
-- unique count but DOES raise the total count.
--
-- p_max_unique / p_max_total NULL == unlimited for that dimension.
-- The caller (web entitlement layer) passes the resolved limits + period so
-- this function stays plan-agnostic and is the single atomic gate.
create or replace function public.consume_usage(
  p_user        uuid,
  p_kind        text,
  p_job         uuid,
  p_max_unique  int,
  p_max_total   int,
  p_period_start timestamptz
)
returns table(allowed boolean, reason text, event_id uuid)
language plpgsql
security definer set search_path = public
as $$
declare
  v_unique   int;
  v_total    int;
  v_job_seen boolean;
  v_new_id   uuid;
begin
  -- Serialize concurrent reservations for this user so two parallel requests
  -- can't both pass the check. Lock the subscription row (or a no-op if none).
  perform 1 from public.subscriptions where user_id = p_user for update;

  select
    count(distinct job_id) filter (where job_id is not null),
    count(*),
    bool_or(job_id is not distinct from p_job and p_job is not null)
  into v_unique, v_total, v_job_seen
  from public.usage_events
  where user_id = p_user
    and kind = p_kind
    and period_start = p_period_start
    and (status = 'committed' or (status = 'pending' and created_at > now() - interval '1 hour'));

  -- Unique cap: only blocks when this is a NEW job for the bucket.
  if p_max_unique is not null and coalesce(v_job_seen, false) = false and v_unique >= p_max_unique then
    return query select false, 'unique_cap'::text, null::uuid;
    return;
  end if;

  -- Total cap: every generation (incl. re-analysis) counts.
  if p_max_total is not null and v_total >= p_max_total then
    return query select false, 'total_cap'::text, null::uuid;
    return;
  end if;

  insert into public.usage_events (user_id, kind, job_id, status, period_start)
  values (p_user, p_kind, p_job, 'pending', p_period_start)
  returning id into v_new_id;

  return query select true, 'ok'::text, v_new_id;
end;
$$;

-- ============================================================
-- Commit / void reservations from the authoritative artifact tables.
-- A reservation is linked by usage_events.ref_id = artifact.id (set by the
-- web layer right after it inserts the analysis_run / cover_letter row).
-- ============================================================
create or replace function public.sync_usage_from_artifact()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if NEW.status = 'completed' then
    update public.usage_events
       set status = 'committed'
     where ref_id = NEW.id and status = 'pending';
  elsif NEW.status = 'failed' then
    update public.usage_events
       set status = 'voided'
     where ref_id = NEW.id and status = 'pending';
  end if;
  return NEW;
end;
$$;

-- 069 — gate-aware variant for analysis_runs: a completed run whose
-- tailored_cv step was 'skipped' (stopped at the initial-ATS gate) produced
-- no CV, so the reservation is VOIDED instead of committed. cover_letters
-- keeps using sync_usage_from_artifact (no step_status / gate concept).
create or replace function public.sync_usage_from_analysis_run()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if NEW.status = 'completed' then
    if coalesce(NEW.step_status->>'tailored_cv', '') = 'skipped' then
      -- Gate-stopped: no tailored CV produced -> free the reservation.
      update public.usage_events
         set status = 'voided'
       where ref_id = NEW.id and status = 'pending';
    else
      update public.usage_events
         set status = 'committed'
       where ref_id = NEW.id and status = 'pending';
    end if;
  elsif NEW.status = 'failed' then
    update public.usage_events
       set status = 'voided'
     where ref_id = NEW.id and status = 'pending';
  end if;
  return NEW;
end;
$$;

create trigger analysis_runs_usage_sync
  after update of status on public.analysis_runs
  for each row execute function public.sync_usage_from_analysis_run();

create trigger cover_letters_usage_sync
  after update of status on public.cover_letters
  for each row execute function public.sync_usage_from_artifact();

-- Allow authenticated users to call consume_usage (SECURITY DEFINER does the work).
grant execute on function public.consume_usage(uuid, text, uuid, int, int, timestamptz) to authenticated, service_role;

-- ============================================================
-- ADMIN OBSERVABILITY (055)
-- ai_calls / pipeline_timings / user_events / admin_audit_log
-- ============================================================
create table if not exists public.ai_calls (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        references public.users(id) on delete set null,
  run_id          uuid        references public.analysis_runs(id) on delete set null,
  -- Which stage of the pipeline called the model (jd_analysis, cv_jd_matching,
  -- tailored_cv, cover_letter, voice_fingerprint, cv_categorise, …)
  operation       text        not null,
  provider        text        not null check (provider in ('anthropic','openai','deepseek')),
  model           text        not null,
  input_tokens    int         not null default 0,
  output_tokens   int         not null default 0,
  cached_tokens   int         not null default 0,   -- Anthropic cache-read tokens
  cost_millicents int         not null default 0,   -- USD millicents
  latency_ms      int         not null default 0,   -- wall-clock for the HTTP call
  retry_count     int         not null default 0,   -- how many transient retries fired
  status          text        not null default 'ok'
                                check (status in ('ok','error','cached')),
  error_type      text,                              -- AIClientError subtype or HTTP code
  created_at      timestamptz not null default now()
);

create index idx_ai_calls_user_id      on public.ai_calls(user_id, created_at desc);
create index idx_ai_calls_run_id       on public.ai_calls(run_id);
create index idx_ai_calls_operation    on public.ai_calls(operation, created_at desc);
create index idx_ai_calls_created_at   on public.ai_calls(created_at desc);
create index idx_ai_calls_status       on public.ai_calls(status, created_at desc);

create table if not exists public.pipeline_timings (
  id          uuid        primary key default gen_random_uuid(),
  run_id      uuid        not null references public.analysis_runs(id) on delete cascade,
  user_id     uuid        references public.users(id) on delete set null,
  step        text        not null,   -- jd_analysis|cv_jd_matching|ats_scoring|…|tailored_cv|total
  started_at  timestamptz not null,
  finished_at timestamptz,
  duration_ms int,                    -- populated on finish: extract(epoch) * 1000
  status      text        not null default 'running'
                            check (status in ('running','completed','failed','skipped')),
  created_at  timestamptz not null default now()
);

create index idx_pipeline_timings_run_id    on public.pipeline_timings(run_id);
create index idx_pipeline_timings_user_id   on public.pipeline_timings(user_id, created_at desc);
create index idx_pipeline_timings_step      on public.pipeline_timings(step, created_at desc);
create index idx_pipeline_timings_created   on public.pipeline_timings(created_at desc);

create table if not exists public.user_events (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references public.users(id) on delete cascade,
  event_type  text        not null,
  metadata    jsonb       not null default '{}',
  ip          text,                    -- login events only
  country     text,                    -- derived from ip (ip-api or MaxMind)
  city        text,
  device      text,                    -- 'mobile'|'desktop'|'tablet' from UA
  created_at  timestamptz not null default now()
);

create index idx_user_events_user_id    on public.user_events(user_id, created_at desc);
create index idx_user_events_type       on public.user_events(event_type, created_at desc);
create index idx_user_events_created_at on public.user_events(created_at desc);

create table if not exists public.admin_audit_log (
  id           uuid        primary key default gen_random_uuid(),
  admin_id     uuid        not null references public.users(id) on delete set null,
  action       text        not null,
  target_type  text,                   -- 'user'|'run'|'invite'|'flag'|…
  target_id    text,                   -- uuid or slug of the affected entity
  metadata     jsonb       not null default '{}',
  created_at   timestamptz not null default now()
);

create index idx_admin_audit_admin_id   on public.admin_audit_log(admin_id, created_at desc);
create index idx_admin_audit_created_at on public.admin_audit_log(created_at desc);
create index idx_admin_audit_action     on public.admin_audit_log(action, created_at desc);

-- admin_daily_ai_cost: per-user per-day cost rollup for the cost dashboard.
create or replace view public.admin_daily_ai_cost as
  select
    user_id,
    date_trunc('day', created_at) as day,
    sum(cost_millicents)          as cost_millicents,
    sum(input_tokens)             as input_tokens,
    sum(output_tokens)            as output_tokens,
    count(*)                      as call_count,
    avg(latency_ms)               as avg_latency_ms,
    count(*) filter (where status = 'error') as error_count
  from public.ai_calls
  group by user_id, date_trunc('day', created_at);

comment on view public.admin_daily_ai_cost is
  'Per-user per-day AI cost rollup. Used by admin cost dashboard.';

-- ============================================================
-- PLATFORM AI SETTINGS (060) — platform-wide provider, replaces BYOK.
-- Seed rows live in 003_seed.sql.
-- ============================================================
create table if not exists public.platform_ai_settings (
  id                 uuid primary key default gen_random_uuid(),
  provider           text not null unique check (provider in ('anthropic', 'openai', 'deepseek')),
  encrypted_api_key  text,
  model              text,
  is_active          boolean not null default false,
  status             text,                 -- 'valid' | 'invalid' | null (untested)
  status_reason      text,
  last_validated_at  timestamptz,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references auth.users(id)
);

create unique index if not exists platform_ai_settings_one_active
  on public.platform_ai_settings (is_active)
  where is_active;

-- ============================================================
-- PLATFORM SOURCES (063) — single admin-controlled global row.
-- Superseded by platform_source_tiers (064) but kept in place.
-- Seed row lives in 003_seed.sql.
-- ============================================================
create table if not exists public.platform_sources (
  id               int  primary key default 1 check (id = 1),
  enabled_sources  text[] not null default '{adzuna,seek,careerjet}',
  adzuna_method    text not null default 'direct' check (adzuna_method in ('api', 'direct')),
  seek_method      text not null default 'direct' check (seek_method in ('direct', 'actor')),
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users(id)
);

-- ============================================================
-- PLATFORM SOURCE TIERS (064) — per-subscription-tier source config.
-- Seed rows (with the net enabled_sources after 070-077) live in 003_seed.sql.
-- ============================================================
create table if not exists public.platform_source_tiers (
  tier             text primary key check (tier in ('weekly', 'monthly', 'unlimited')),
  enabled_sources  text[] not null default '{adzuna,seek,careerjet}',
  adzuna_method    text not null default 'api' check (adzuna_method in ('api', 'direct')),
  seek_method      text not null default 'direct' check (seek_method in ('direct', 'actor')),
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users(id)
);

-- ============================================================
-- SEARCH COVERAGE (066) — global job-bucket freshness ledger.
-- One row per (normalised keyword × location-cell × source) slice.
-- ============================================================
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

create trigger search_coverage_set_updated_at
  before update on public.search_coverage
  for each row execute function public.set_updated_at();

-- ============================================================
-- GLOBAL JOBS (067) — canonical deduplicated job bucket.
-- + 078 work-setting columns + 080 JD-facts columns.
-- ============================================================
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

  created_at          timestamptz not null default now(),
  -- 078: shared once-per-posting work-setting classification (canonical)
  setting_category   text,
  setting_confidence real,
  setting_evidence   text,
  -- 080: JD facts extraction (mirrors public.jobs)
  employment_types        text[],
  employment_source       text
    check (employment_source in ('structured','regex') or employment_source is null),
  work_rights_requirement text
    check (work_rights_requirement in
      ('citizen_only','pr_citizen','full_unrestricted','any_valid','not_stated')
      or work_rights_requirement is null),
  extracted_emails        jsonb,
  salary_period           text
    check (salary_period in ('hour','day','week','fortnight','year') or salary_period is null),
  closing_date            date,
  shift_patterns          text[],
  is_agency               boolean
);

create index if not exists idx_global_jobs_location_cell on public.global_jobs (location_cell);
create index if not exists idx_global_jobs_matched_keywords on public.global_jobs using gin (matched_keywords);
create index if not exists idx_global_jobs_posted_at on public.global_jobs (posted_at desc);
create index if not exists idx_global_jobs_first_seen_at on public.global_jobs (first_seen_at desc);

-- ============================================================
-- PROFILE JOBS (068) — per-user link + state for the global bucket.
-- ============================================================
create table if not exists public.profile_jobs (
  id               uuid primary key default gen_random_uuid(),
  profile_id       uuid not null references public.search_profiles(id) on delete cascade,
  global_job_id    uuid not null references public.global_jobs(id) on delete cascade,

  keywords_matched text[] not null default '{}',  -- which of THIS user's keywords hit
  ai_relevance_score float,                        -- per-user (depends on their CV)
  distance_km      numeric,                        -- per-user (their home address)
  distance_method  text,

  manual_jd_text   text,                           -- user's own JD edits
  contact_email    text,                           -- user's own recruiter contact

  seen_at          timestamptz,
  applied_at       timestamptz,
  dismissed_at     timestamptz,
  pool_decision_at timestamptz,
  is_starred       boolean not null default false,

  created_at       timestamptz not null default now(),
  unique (profile_id, global_job_id)
);

create index if not exists idx_profile_jobs_profile_created
  on public.profile_jobs (profile_id, created_at desc);
create index if not exists idx_profile_jobs_global_job
  on public.profile_jobs (global_job_id);

-- ============================================================
-- ENGAGEMENT + NOTIFICATIONS (079)
-- ============================================================
create table if not exists public.user_engagement (
  user_id             uuid primary key references public.users(id) on delete cascade,
  last_seen_at        timestamptz not null default now(),
  inactivity_warned_at timestamptz,
  notify_new_jobs     boolean not null default true,
  updated_at          timestamptz not null default now()
);

create table if not exists public.profile_pause_state (
  profile_id  uuid primary key references public.search_profiles(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  reason      text not null check (reason in ('inactivity','subscription')),
  paused_at   timestamptz not null default now()
);

create table if not exists public.pending_job_notifications (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  profile_id    uuid not null references public.search_profiles(id) on delete cascade,
  profile_name  text not null default '',
  jobs_saved    int not null,
  created_at    timestamptz not null default now(),
  claimed_at    timestamptz,
  sent_at       timestamptz
);

-- Sweep query: unsent rows ordered by recency, per user.
create index if not exists pending_job_notifications_unsent_idx
  on public.pending_job_notifications (user_id, created_at)
  where sent_at is null;

-- touch_user_engagement() — bump last_seen_at, throttled to once/hour.
create or replace function public.touch_user_engagement()
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    return;
  end if;

  insert into public.user_engagement (user_id)
  values (auth.uid())
  on conflict (user_id) do update
    set last_seen_at = now(),
        updated_at   = now()
    where public.user_engagement.last_seen_at < now() - interval '1 hour';
end;
$$;

grant execute on function public.touch_user_engagement() to authenticated;

-- ============================================================
-- CHECK USER AUTH METHODS (081) — SSO-only detection for
-- forgot-password without touching the recovery-token cooldown.
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_user_auth_methods(p_email text)
RETURNS TABLE(user_exists boolean, has_password boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT
    EXISTS (SELECT 1 FROM auth.users u WHERE u.email = p_email) AS user_exists,
    EXISTS (
      SELECT 1 FROM auth.users u
      JOIN auth.identities i ON i.user_id = u.id
      WHERE u.email = p_email AND i.provider = 'email'
    ) AS has_password;
$$;

-- Callable only by the service-role client (server-side code) — never
-- exposed to the anon/authenticated PostgREST roles the browser client uses.
REVOKE ALL ON FUNCTION public.check_user_auth_methods(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_user_auth_methods(text) TO service_role;

-- ============================================================
-- REALTIME PUBLICATION
-- Frontend subscribes to row-level changes on these tables (RLS-filtered):
-- analysis_runs (011), cover_letters (025), applications (031),
-- run_logs (052 — guarded, may already be a member via the dashboard).
-- ============================================================
alter publication supabase_realtime add table public.analysis_runs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.cover_letters;
ALTER PUBLICATION supabase_realtime ADD TABLE applications;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'run_logs'
  ) then
    alter publication supabase_realtime add table public.run_logs;
  end if;
end
$$;
