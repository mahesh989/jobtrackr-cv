-- ============================================================
-- 055_admin_observability.sql
--
-- Instrumentation tables for the admin console.
--
-- Four tables:
--   ai_calls          — one row per LLM API call (cost, latency, tokens, errors)
--   pipeline_timings  — per-stage wall-clock on analysis_runs
--   user_events       — user activity stream (page views, key actions, logins)
--   admin_audit_log   — every privileged action taken by a founder/admin
--
-- Design principles:
--   * All writes are service-role only (cv-backend or server actions).
--   * RLS: founders/admins can SELECT *; users can SELECT their own events.
--   * Tables are append-only (no UPDATE/DELETE for non-service-role).
--   * All numeric costs stored as integer millicents (USD cents × 1000)
--     so we never lose sub-cent precision in arithmetic.
--   * Indexes biased toward the admin console's access patterns:
--     time-range scans, per-user aggregates, per-operation aggregates.
-- ============================================================

-- ── AI_CALLS ──────────────────────────────────────────────────────────────────
-- One row per synchronous LLM API call made by cv-backend.
-- Emitted by AIClient.complete() / complete_json() after the response arrives.
-- Also emitted for cached responses (latency_ms = 0, status = 'cached').
--
-- cost_millicents: provider-billed cost in USD millicents (cents × 1000).
--   Anthropic input = $3 / 1M tokens → 3 millicents/token → int arithmetic exact.
--   Populated from the MODEL_PRICES table baked into the client.
--
-- cached_tokens: Anthropic prompt-cache hit tokens (future — zero for now,
--   populated once prompt-caching is enabled in Phase 3).
-- ─────────────────────────────────────────────────────────────────────────────
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

-- ── PIPELINE_TIMINGS ─────────────────────────────────────────────────────────
-- Per-step wall-clock for each analysis_run.  One row per (run_id, step) pair.
-- Written by the orchestrator at step start/finish — additive with existing
-- mark_step() calls, not a replacement.
-- ─────────────────────────────────────────────────────────────────────────────
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

-- ── USER_EVENTS ──────────────────────────────────────────────────────────────
-- User activity stream.  Written by:
--   * Web server actions / API routes (page_view, analysis_started, etc.)
--   * cv-backend internal route (analysis_completed, pipeline_failed, etc.)
--
-- event_type taxonomy (extensible — add without migration):
--   auth:         login, logout
--   analysis:     analysis_started, analysis_completed, analysis_failed, analysis_cancelled
--   cv:           cv_uploaded, cv_downloaded, cover_letter_generated
--   application:  email_sent, zip_downloaded, applied_external
--   settings:     profile_saved, email_connected, theme_changed
--   billing:      trial_started, plan_upgraded, plan_cancelled
--   nav:          page_view (path in metadata)
--
-- metadata: free-form JSONB — keep small (<1kB). E.g.:
--   {"path": "/dashboard/jobs", "job_id": "…"}
--   {"provider": "google", "from_address": "…@gmail.com"}
--   {"run_id": "…", "tailored_score": 82, "lift": 12}
--
-- ip + country populated by the web layer on login events only
-- (not for every page view — minimise PII surface).
-- ─────────────────────────────────────────────────────────────────────────────
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

-- ── ADMIN_AUDIT_LOG ──────────────────────────────────────────────────────────
-- Immutable append-only log of privileged actions.
-- action taxonomy (extensible):
--   invite_generated, invite_revoked
--   user_role_changed, user_impersonated
--   feature_flag_toggled, api_key_rotated
--   run_triggered_for_user, run_cancelled_for_user
-- ─────────────────────────────────────────────────────────────────────────────
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

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.ai_calls         enable row level security;
alter table public.pipeline_timings enable row level security;
alter table public.user_events      enable row level security;
alter table public.admin_audit_log  enable row level security;

-- Service-role bypasses RLS entirely (cv-backend writes).
-- Founders/admins can read all rows.
-- Users can only read their own user_events.

create policy "admin_read_ai_calls" on public.ai_calls
  for select to authenticated
  using (
    exists (select 1 from public.users where id = auth.uid() and role in ('founder','admin'))
  );

create policy "admin_read_pipeline_timings" on public.pipeline_timings
  for select to authenticated
  using (
    exists (select 1 from public.users where id = auth.uid() and role in ('founder','admin'))
  );

create policy "admin_read_user_events" on public.user_events
  for select to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.users where id = auth.uid() and role in ('founder','admin'))
  );

create policy "admin_read_admin_audit_log" on public.admin_audit_log
  for select to authenticated
  using (
    exists (select 1 from public.users where id = auth.uid() and role in ('founder','admin'))
  );

-- ── HELPER VIEWS ─────────────────────────────────────────────────────────────
-- admin_daily_ai_cost: per-user per-day cost rollup for the cost dashboard.
-- No RLS needed — views inherit the underlying table's policies.
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
