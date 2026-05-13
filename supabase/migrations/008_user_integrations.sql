-- ============================================================
-- Migration 008: user_integrations
--
-- Stores per-user third-party integration credentials (Apify today,
-- LinkedIn / Indeed / etc. tomorrow). Credentials are encrypted at
-- the application layer using AES-256-GCM before being stored —
-- the raw token never appears in this table.
--
-- Env var required in both web app and worker:
--   INTEGRATION_ENCRYPTION_KEY = <64 hex chars / 32 bytes random>
--   Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
-- ============================================================

-- ── Status enum ───────────────────────────────────────────────────────────────
-- More expressive than a boolean — covers every real state a credential can be in.
-- Use text CHECK instead of PG ENUM so adding new values = one migration line,
-- not an ALTER TYPE (which can't run inside a transaction).

-- ── Table ─────────────────────────────────────────────────────────────────────
create table public.user_integrations (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references public.users(id) on delete cascade,

  -- Which third-party service: 'apify', 'linkedin', 'indeed', …
  -- Text + check constraint: extend by adding a value here + one migration line.
  provider            text        not null,

  -- ── Credential ─────────────────────────────────────────────────────────────
  -- AES-256-GCM encrypted blob. Format: base64(iv[16] || authTag[16] || ciphertext).
  -- Only the worker and server-side API routes hold the decryption key.
  -- The browser never sees this column (RLS exposes only non-sensitive fields).
  encrypted_api_key   text        not null,

  -- ── Validity state ──────────────────────────────────────────────────────────
  -- pending_validation  just connected, not yet confirmed working
  -- valid               working as of last_validated_at
  -- invalid             failed validation (wrong key, format error)
  -- expired             was valid, provider says it has expired
  -- revoked             user revoked in provider's own dashboard
  -- quota_exceeded      valid token but monthly budget reached
  -- disabled            intentionally paused by user or admin
  status              text        not null default 'pending_validation'
                        check (status in (
                          'pending_validation','valid','invalid',
                          'expired','revoked','quota_exceeded','disabled'
                        )),
  status_reason       text,               -- human-readable reason, shown in UI
  last_validated_at   timestamptz,        -- when we last confirmed it worked
  last_used_at        timestamptz,        -- when a pipeline last used it

  -- ── Quota tracking ──────────────────────────────────────────────────────────
  -- Two fields cover both pricing models: dollar-based (Apify) and request-based.
  -- Worker resets both to 0 whenever now() > quota_period_start + 1 month.
  quota_used_usd      numeric(10,6) not null default 0,
  quota_used_requests integer       not null default 0,
  quota_period_start  date          not null
                        default date_trunc('month', current_date)::date,

  -- ── Provider-specific non-sensitive config ──────────────────────────────────
  -- e.g. {"actor_id": "automation-lab~seek-scraper", "max_results_per_keyword": 200}
  -- Keeps provider quirks out of code columns. Never store sensitive data here.
  config              jsonb         not null default '{}',

  -- ── Soft controls ───────────────────────────────────────────────────────────
  is_enabled          boolean       not null default true,

  -- ── Audit ───────────────────────────────────────────────────────────────────
  created_at          timestamptz   not null default now(),
  updated_at          timestamptz   not null default now(),

  -- One active credential per provider per user
  constraint uq_user_provider unique (user_id, provider),

  -- Known providers — add new ones here as a single migration line
  constraint chk_provider check (provider in ('apify', 'linkedin', 'indeed'))
);

create index idx_user_integrations_user_id on public.user_integrations(user_id);
create index idx_user_integrations_provider on public.user_integrations(provider);
create index idx_user_integrations_status  on public.user_integrations(status);

-- Auto-update updated_at
create trigger user_integrations_updated_at
  before update on public.user_integrations
  for each row execute function public.set_updated_at();

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- Users can read and manage only their own rows.
-- The browser NEVER receives encrypted_api_key — the API route strips it before
-- returning status responses. The worker uses the service-role client (bypasses RLS).
alter table public.user_integrations enable row level security;

create policy "users_own_integrations"
  on public.user_integrations
  for all
  using     (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── Admin view ────────────────────────────────────────────────────────────────
-- Query with service-role client only. Joins integrations → users → profiles → run_logs.
-- Note: encrypted_api_key is deliberately excluded.
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
