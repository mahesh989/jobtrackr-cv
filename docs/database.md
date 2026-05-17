# JobTrackr-CV — Database Reference

> Derived from migrations `001`–`020` — the single source of truth.
> All migrations were applied manually via Supabase SQL Editor (CLI never linked; see OPS-1 in `.claude/graph.json`).
> **Additive only** — never ALTER existing JobTrackr base tables (`jobs`, `search_profiles`, etc.). New columns and new `user_integrations.provider` values only.

---

## Migration History

| # | File | What it adds |
|---|------|--------------|
| 001 | `001_schema.sql` | Base schema: `invite_codes`, `users`, `search_profiles`, `jobs`, `run_logs`, `ai_cache`; extensions `pgcrypto`, `pg_trgm` |
| 002 | `002_rls.sql` | RLS enabled + policies for all 001 tables |
| 003 | `003_seed_founder.sql` | Founder invite code seed (no schema change) |
| 004 | `004_ai_usage.sql` | `run_logs` — AI usage columns + `monthly_ai_spend_millicents()` function |
| 005 | `005_salary.sql` | `jobs` — `salary_min`, `salary_max` |
| 006 | `006_vertical_filter.sql` | `search_profiles` — `target_verticals` |
| 007 | `007_adzuna_advanced.sql` | `search_profiles` — 11 Adzuna-specific filter columns |
| 008 | `008_user_integrations.sql` | `user_integrations` table + RLS + admin view; initial providers: `apify`, `linkedin`, `indeed` |
| 009 | `009_add_possible_duplicate_dedup_status.sql` | `jobs.dedup_status` — adds `possible_duplicate` value |
| 010 | `010_cv_versions.sql` | `cv_versions` table + RLS |
| 011 | `011_analysis_runs.sql` | `analysis_runs` table + RLS + Realtime publication |
| 012 | `012_extend_user_integrations.sql` | `user_integrations.provider` — adds `anthropic`, `openai` |
| 013 | `013_storage_buckets.sql` | Storage buckets `cvs` (5 MB PDF/DOCX) and `tailored-cvs` (10 MB PDF) + RLS |
| 014 | `014_add_deepseek_provider.sql` | `user_integrations.provider` — adds `deepseek` |
| 015 | `015_jobs_manual_jd_and_email.sql` | `jobs` — `manual_jd_text`, `contact_email` |
| 016 | `016_cv_categorised_skills.sql` | `cv_versions` — `categorised_skills` JSONB |
| 017 | `017_cascade_delete_analysis_runs_with_cv.sql` | `analysis_runs.cv_version_id` FK changed to `ON DELETE CASCADE` |
| 018 | `018_analysis_runs_provenance.sql` | `analysis_runs` — `ai_provider`, `ai_model` |
| 019 | `019_tailored_bucket_allow_markdown.sql` | `tailored-cvs` bucket — adds `text/markdown` to MIME allow-list |
| 020 | `020_user_preferences.sql` | `user_preferences` table + RLS |

---

## Tables

### `invite_codes`
Created: 001 | RLS: 002

| Column | Type | Notes |
|--------|------|-------|
| `code` | `text` | **PK** |
| `created_by` | `uuid` | → `auth.users` ON DELETE SET NULL |
| `used_by` | `uuid` | → `auth.users` ON DELETE SET NULL |
| `used_at` | `timestamptz` | |
| `is_active` | `boolean` | default `true` |
| `created_at` | `timestamptz` | default `now()` |

**RLS:** `invite_codes_read` — anyone can SELECT (validates during signup). INSERT/UPDATE via service-role only.

---

### `users`
Created: 001 | RLS: 002

Public profile row, 1:1 with `auth.users`. Created automatically by the `on_auth_user_created` trigger (`handle_new_user()`).

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | **PK**, → `auth.users` ON DELETE CASCADE |
| `email` | `text` | not null |
| `role` | `text` | `'founder' \| 'beta' \| 'admin'` default `'beta'` |
| `invite_code_used` | `text` | → `invite_codes(code)` ON DELETE SET NULL |
| `created_at` | `timestamptz` | default `now()` |

**RLS:** `users_select_own` / `users_update_own` — `id = auth.uid()`.

---

### `search_profiles`
Created: 001 | Extended: 006, 007 | RLS: 002

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | **PK** default `gen_random_uuid()` |
| `user_id` | `uuid` | → `users` ON DELETE CASCADE |
| `name` | `text` | |
| `keywords` | `text[]` | default `{}` |
| `location` | `text` | default `''` |
| `visa_filter_mode` | `text` | `'probability_sort' \| 'any' \| 'sponsored_only'` |
| `schedule_cron` | `text` | default `'0 7 */2 * *'` |
| `is_active` | `boolean` | default `false` |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | auto-updated by `set_updated_at()` trigger |
| `target_verticals` | `text[]` | *006* default `{"general","tech","healthcare"}` |
| `adzuna_title_keywords` | `text` | *007* |
| `adzuna_exact_phrase` | `text` | *007* |
| `adzuna_any_keywords` | `text` | *007* |
| `adzuna_exclude_keywords` | `text` | *007* |
| `adzuna_salary_min` | `int` | *007* nullable |
| `adzuna_salary_max` | `int` | *007* nullable |
| `adzuna_contract_type` | `text` | *007* `'permanent' \| 'contract'` nullable |
| `adzuna_hours` | `text` | *007* `'full_time' \| 'part_time'` nullable |
| `adzuna_distance_km` | `int` | *007* default `25` |
| `adzuna_max_days_old` | `int` | *007* default `14` |
| `exclude_title_keywords` | `text[]` | *007* default `{}` |

**Indexes:** `idx_search_profiles_user_id`

**RLS:** `profiles_select/insert/update/delete_own` — `user_id = auth.uid()`.

---

### `jobs`
Created: 001 | Extended: 005, 009, 015 | RLS: 002

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | **PK** |
| `profile_id` | `uuid` | → `search_profiles` ON DELETE CASCADE |
| `url_hash` | `text` | `sha256(canonical_url)` |
| `url` | `text` | |
| `title` | `text` | |
| `company` | `text` | default `''` |
| `location` | `text` | default `''` |
| `description` | `text` | scraped JD text |
| `source` | `text` | `'adzuna'` \| `'greenhouse'` \| etc. |
| `source_tier` | `int` | default `1` |
| `posted_at` | `timestamptz` | nullable |
| `expires_at` | `timestamptz` | nullable |
| `is_expired` | `boolean` | default `false` |
| `is_dead_link` | `boolean` | default `false` |
| `dedup_status` | `text` | *001+009* `'original' \| 'duplicate' \| 'repost' \| 'possible_duplicate'` |
| `duplicate_of` | `uuid` | → `jobs` ON DELETE SET NULL |
| `repost_of` | `uuid` | → `jobs` ON DELETE SET NULL |
| `ai_relevance_score` | `float` | 0–1, null until scored |
| `visa_likelihood` | `float` | 0–1, null until scored |
| `keywords_matched` | `text[]` | default `{}` |
| `seen_at` | `timestamptz` | nullable |
| `applied_at` | `timestamptz` | nullable |
| `dismissed_at` | `timestamptz` | nullable |
| `created_at` | `timestamptz` | |
| `salary_min` | `numeric` | *005* nullable |
| `salary_max` | `numeric` | *005* nullable |
| `manual_jd_text` | `text` | *015* user-edited JD; when set, overrides `description` in pipeline |
| `contact_email` | `text` | *015* optional recruiter contact for future email flow |

**Unique constraint:** `(profile_id, url_hash)`

**Indexes:** `profile_id`, `(profile_id, ai_relevance_score DESC)`, `(profile_id, visa_likelihood DESC)`, `(profile_id, created_at DESC)`, partial on `is_expired=false`, partial on `is_dead_link=false`, GIN trgm on `title`

**RLS:** `jobs_select/insert/update/delete_own` — via join to `search_profiles` on `user_id = auth.uid()`.

---

### `run_logs`
Created: 001 | Extended: 004 | RLS: 002

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | **PK** |
| `profile_id` | `uuid` | → `search_profiles` ON DELETE CASCADE |
| `started_at` | `timestamptz` | |
| `finished_at` | `timestamptz` | nullable |
| `status` | `text` | `'running' \| 'completed' \| 'failed'` |
| `jobs_fetched` | `int` | default `0` |
| `jobs_after_dedup` | `int` | default `0` |
| `jobs_saved` | `int` | default `0` |
| `error_message` | `text` | nullable |
| `sources_run` | `text[]` | default `{}` |
| `created_at` | `timestamptz` | |
| `ai_tokens_input` | `int` | *004* default `0` |
| `ai_tokens_output` | `int` | *004* default `0` |
| `ai_cost_cents` | `int` | *004* USD millicents, default `0` |
| `ai_batch_id` | `text` | *004* Anthropic batch ID, nullable |

**Function:** `monthly_ai_spend_millicents(p_user_id uuid) → int` — sums `ai_cost_cents` for current calendar month.

**Indexes:** `(profile_id, started_at DESC)`

**RLS:** `run_logs_select/insert_own` — via join to `search_profiles`.

---

### `ai_cache`
Created: 001 | RLS: 002

| Column | Type | Notes |
|--------|------|-------|
| `cache_key` | `text` | **PK** — `sha256(url_hash:keywords_hash)` |
| `profile_id` | `uuid` | → `search_profiles` ON DELETE CASCADE, nullable |
| `result_json` | `jsonb` | `{ relevance_score, visa_likelihood, visa_signals[] }` |
| `created_at` | `timestamptz` | |
| `expires_at` | `timestamptz` | default `now() + 30 days` |

**Function:** `purge_expired_ai_cache() → int` — deletes rows where `expires_at < now()`.

**Indexes:** `expires_at`, `profile_id`

**RLS:** `ai_cache_select_own` — allows null `profile_id` or own profiles. Worker writes via service-role.

---

### `user_integrations`
Created: 008 | Extended: 012 (added `anthropic`, `openai`), 014 (added `deepseek`) | RLS: 008

Stores per-user third-party credentials (worker keys + BYOK AI keys). Credentials are AES-256-GCM encrypted before storage — `encrypted_api_key` format: `base64(iv[16] || authTag[16] || ciphertext)`. One row per `(user_id, provider)`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | **PK** |
| `user_id` | `uuid` | → `users` ON DELETE CASCADE |
| `provider` | `text` | `'apify' \| 'linkedin' \| 'indeed' \| 'anthropic' \| 'openai' \| 'deepseek'` (final after 014) |
| `encrypted_api_key` | `text` | AES-256-GCM blob; never returned to browser |
| `status` | `text` | `'pending_validation' \| 'valid' \| 'invalid' \| 'expired' \| 'revoked' \| 'quota_exceeded' \| 'disabled'` |
| `status_reason` | `text` | human-readable, shown in UI |
| `last_validated_at` | `timestamptz` | nullable |
| `last_used_at` | `timestamptz` | nullable |
| `quota_used_usd` | `numeric(10,6)` | default `0` |
| `quota_used_requests` | `integer` | default `0` |
| `quota_period_start` | `date` | resets monthly; default `date_trunc('month', current_date)` |
| `config` | `jsonb` | provider-specific non-sensitive config; default `{}` |
| `is_enabled` | `boolean` | default `true` |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | auto-updated |

**Unique constraint:** `uq_user_provider (user_id, provider)`

**Indexes:** `user_id`, `provider`, `status`

**RLS:** `users_own_integrations` — all operations: `auth.uid() = user_id`.

**View:** `admin_integrations_overview` — service-role only; joins users + profiles + run_logs; excludes `encrypted_api_key`.

---

### `cv_versions`
Created: 010 | Extended: 016 | RLS: 010

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | **PK** |
| `user_id` | `uuid` | → `users` ON DELETE CASCADE |
| `label` | `text` | e.g. `"Master CV — 2026"` |
| `pdf_storage_path` | `text` | `cvs/{user_id}/{cv_version_id}.pdf` |
| `cv_text` | `text` | plain-text extraction via pypdf/python-docx |
| `is_active` | `boolean` | default `false` |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | auto-updated |
| `categorised_skills` | `jsonb` | *016* `{ "technical": [...], "soft_skills": [...], "domain_knowledge": [...] }` — null while pending or no AI key |

**Unique index:** `uq_one_active_cv_per_user (user_id) WHERE is_active = true` — enforces exactly one active CV per user.

**Indexes:** `user_id`, `created_at DESC`

**RLS:** `users_own_cv_versions` — all operations: `auth.uid() = user_id`.

---

### `analysis_runs`
Created: 011 | Extended: 017 (CASCADE FK), 018 (provenance) | RLS: 011

One row per CV-tailoring analysis. Written by cv-backend via service-role. Browser subscribes via Supabase Realtime (`supabase_realtime` publication) for live step progress.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | **PK** |
| `user_id` | `uuid` | → `users` ON DELETE CASCADE |
| `job_id` | `uuid` | → `jobs` ON DELETE CASCADE |
| `cv_version_id` | `uuid` | → `cv_versions` ON DELETE CASCADE (*017* changed from RESTRICT) |
| `status` | `text` | `'pending' \| 'running' \| 'completed' \| 'failed'` |
| `step_status` | `jsonb` | 7-key JSONB — see below |
| `jd_text` | `text` | snapshot of JD text at run start |
| `jd_analysis_result` | `jsonb` | Step 1 output |
| `cv_jd_matching_result` | `jsonb` | Step 2 output |
| `ats_scoring_result` | `jsonb` | Step 3 output |
| `input_recommendations` | `jsonb` | Step 4 output |
| `keyword_feasibility` | `jsonb` | Step 4.5 output |
| `ai_recommendations` | `text` | Step 5 output (markdown) |
| `tailored_cv_storage_path` | `text` | Step 6 markdown in Storage |
| `tailored_pdf_storage_path` | `text` | Step 6 ReportLab PDF in Storage |
| `tailored_ats_scoring_result` | `jsonb` | Step 6 re-scoring |
| `injected_keywords` | `jsonb` | Step 6 injected keywords |
| `match_score` | `integer` | denormalised (Step 2) |
| `tailored_match_score` | `integer` | denormalised (Step 6) |
| `ats_lift` | `integer` | ATS score gain after tailoring |
| `is_stale` | `boolean` | default `false` |
| `error_message` | `text` | nullable |
| `started_at` | `timestamptz` | nullable |
| `completed_at` | `timestamptz` | nullable |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | auto-updated; Realtime fires on each write |
| `ai_provider` | `text` | *018* `'anthropic' \| 'openai' \| 'deepseek'` |
| `ai_model` | `text` | *018* exact model ID (e.g. `'claude-sonnet-4-6'`) |

**`step_status` keys (all 7, each value `'pending' | 'running' | 'completed' | 'failed'`):**
```
jd_analysis | cv_jd_matching | ats_scoring | input_recommendations
keyword_feasibility | ai_recommendations | tailored_cv
```

**Indexes:** `user_id`, `job_id`, `(user_id, job_id)`, `status`, partial `(user_id, job_id, created_at DESC) WHERE is_stale = false`

**RLS:** `users_own_analysis_runs` — all operations: `auth.uid() = user_id`. cv-backend writes via service-role (bypasses RLS).

**Realtime:** `analysis_runs` added to `supabase_realtime` publication. Browser subscribes to `postgres_changes` on this table, filtered by `user_id`, to animate step cards progressively.

---

### `user_preferences`
Created: 020 | RLS: 020

One row per user (UNIQUE constraint on `user_id`). Stamped onto tailored CV by `stamp_contact_line()`. Projects are appended to `cv_text` at analysis time so the AI sees them even if absent from the uploaded PDF.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | **PK** |
| `user_id` | `uuid` | → `users` ON DELETE CASCADE; UNIQUE |
| `contact_details` | `jsonb` | nullable — see shape below |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | auto-updated |

**`contact_details` shape:**
```json
{
  "name": "string",
  "phone": "string",
  "email": "string",
  "address": "string",
  "linkedin": "string",
  "github": "string",
  "website": "string",
  "portfolio": "string (single URL)",
  "other_label": "string",
  "other_url": "string",
  "projects": [
    { "name": "string", "url": "string", "description": "string" }
  ]
}
```

**RLS:** `users_own_preferences` — all operations: `auth.uid() = user_id`.

---

## Storage Buckets

Both buckets are **private** (no public URLs). Browser downloads via signed URLs or the Supabase client (RLS-scoped). cv-backend uploads via service-role (bypasses RLS).

Path convention: `{user_id}/{cv_or_run_id}.{ext}` — RLS uses `storage.foldername(name)[1] = auth.uid()::text`.

| Bucket | Max size | MIME types | Who writes |
|--------|----------|------------|------------|
| `cvs` | 5 MB | `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | Browser (direct upload) |
| `tailored-cvs` | 10 MB | `application/pdf`, `text/markdown` (*019* widened from PDF-only) | cv-backend (service-role) |

**`cvs` RLS:** owner SELECT / INSERT / UPDATE / DELETE — `bucket_id = 'cvs' AND auth.uid()::text = foldername[1]`

**`tailored-cvs` RLS:** owner SELECT only — `bucket_id = 'tailored-cvs' AND auth.uid()::text = foldername[1]` (cv-backend writes bypass RLS)

---

## Shared Functions & Triggers

| Object | Type | Table | Purpose |
|--------|------|-------|---------|
| `handle_new_user()` | trigger fn | `auth.users` → `users` | Auto-creates `public.users` row on confirmed signup |
| `set_updated_at()` | trigger fn | multiple | Sets `updated_at = now()` on UPDATE |
| `purge_expired_ai_cache()` | function | `ai_cache` | Deletes rows where `expires_at < now()`; returns deleted count |
| `monthly_ai_spend_millicents(uuid)` | function | `run_logs` | Sums `ai_cost_cents` for current calendar month for a user |

**Triggers using `set_updated_at()`:** `search_profiles`, `user_integrations`, `cv_versions`, `analysis_runs`, `user_preferences`

---

## Extensions

| Extension | Enabled in | Purpose |
|-----------|-----------|---------|
| `pgcrypto` | 001 | `gen_random_uuid()` |
| `pg_trgm` | 001 | GIN trigram index on `jobs.title` for future L3 dedup fuzzy match (Phase 8) |
