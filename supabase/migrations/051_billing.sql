-- ============================================================
-- 051_billing.sql — Stripe subscriptions + usage metering
-- ============================================================
-- Monetizes the PLATFORM (not AI tokens — BYOK stays). Adds:
--   plans         — static plan catalogue (limits live in the DB, seeded below)
--   subscriptions — one row per user, authoritative mirror of Stripe state
--   usage_events  — reservation ledger (reserve/commit/void) per metered action
--   stripe_events — webhook idempotency (dedupe Stripe retries)
--   consume_usage() — atomic cap-check + reservation RPC
--   triggers on analysis_runs / cover_letters — commit/void reservations
--
-- Metering model (decided 2026-06-02):
--   * Two SEPARATE buckets: 'tailored_cv' (produced by analyze) and
--     'cover_letter'. Equal caps; either/or.
--   * total = unique * 1.5 (re-analysis headroom).
--   * Trial: 3 unique / 3 total each, 1 profile, 1 run, 3-day window.
--   * Weekly: 50 unique / 75 total, 5 profiles, 30 runs.
--   * Monthly: 250 unique / 375 total, 10 profiles, 120 runs.
--   * Unlimited: NULL caps (∞).
--   * Caps reset per Stripe billing period (counted by current_period_start).
--   * Pricing numbers (price_cents) are PLACEHOLDERS — finalize before go-live.
--
-- Enforcement is web-layer-only (4 choke points). cv-backend + worker are
-- billing-unaware. RLS: users read their own rows; only service-role writes.
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

  price_cents        int  not null default 0,   -- AUD cents (placeholder)
  currency           text not null default 'aud',
  sort_order         int  not null default 0,
  is_public          boolean not null default true,  -- shown on pricing page
  is_active          boolean not null default true
);

-- Seed / upsert plan catalogue. Idempotent — safe to re-run.
insert into public.plans
  (id, display_name, stripe_price_id, billing_interval, trial_days,
   max_profiles, max_runs, max_cv_unique, max_cv_total, max_letter_unique, max_letter_total,
   price_cents, sort_order, is_public)
values
  ('trial',     'Free trial',  null, 'day',   3,  1,   1,    3,    3,    3,    3,        0,   0, false),
  ('weekly',    'Weekly',      null, 'week',  0,  5,   30,   50,   75,   50,   75,     999,   1, true),
  ('monthly',   'Monthly',     null, 'month', 0,  10,  120,  250,  375,  250,  375,   2499,   2, true),
  ('unlimited', 'Unlimited',   null, 'month', 0,  null, null, null, null, null, null,  4999,   3, true),
  ('comp',      'Complimentary', null, 'month', 0, null, null, null, null, null, null,    0, 100, false)
on conflict (id) do update set
  display_name      = excluded.display_name,
  billing_interval  = excluded.billing_interval,
  trial_days        = excluded.trial_days,
  max_profiles      = excluded.max_profiles,
  max_runs          = excluded.max_runs,
  max_cv_unique     = excluded.max_cv_unique,
  max_cv_total      = excluded.max_cv_total,
  max_letter_unique = excluded.max_letter_unique,
  max_letter_total  = excluded.max_letter_total,
  price_cents       = excluded.price_cents,
  sort_order        = excluded.sort_order,
  is_public         = excluded.is_public;

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

drop trigger if exists analysis_runs_usage_sync on public.analysis_runs;
create trigger analysis_runs_usage_sync
  after update of status on public.analysis_runs
  for each row execute function public.sync_usage_from_artifact();

drop trigger if exists cover_letters_usage_sync on public.cover_letters;
create trigger cover_letters_usage_sync
  after update of status on public.cover_letters
  for each row execute function public.sync_usage_from_artifact();

-- ============================================================
-- Grandfather existing beta users — comp subscription, 14-day grace.
-- New signups after this migration get NO subscription row and must start a
-- trial via Checkout (card upfront).
-- ============================================================
insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end)
select u.id, 'comp', 'comp', now(), now() + interval '14 days'
from public.users u
where u.role = 'beta'
  and not exists (select 1 from public.subscriptions s where s.user_id = u.id)
on conflict (user_id) do nothing;

-- Founders/admins never need a subscription row (entitlement layer bypasses
-- them by role), but a comp row keeps the billing UI sane if they visit it.
insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end)
select u.id, 'comp', 'comp', now(), now() + interval '3650 days'
from public.users u
where u.role in ('founder','admin')
  and not exists (select 1 from public.subscriptions s where s.user_id = u.id)
on conflict (user_id) do nothing;

-- ============================================================
-- RLS — users read their own billing rows; only service-role writes.
-- ============================================================
alter table public.plans         enable row level security;
alter table public.subscriptions enable row level security;
alter table public.usage_events  enable row level security;
alter table public.stripe_events enable row level security;

drop policy if exists plans_public_read on public.plans;
create policy plans_public_read on public.plans
  for select using (true);

drop policy if exists subscriptions_own_read on public.subscriptions;
create policy subscriptions_own_read on public.subscriptions
  for select using (auth.uid() = user_id);

drop policy if exists usage_events_own_read on public.usage_events;
create policy usage_events_own_read on public.usage_events
  for select using (auth.uid() = user_id);

-- stripe_events: no client policy (service-role only; RLS denies all by default).

-- Allow authenticated users to call consume_usage (SECURITY DEFINER does the work).
grant execute on function public.consume_usage(uuid, text, uuid, int, int, timestamptz) to authenticated, service_role;
