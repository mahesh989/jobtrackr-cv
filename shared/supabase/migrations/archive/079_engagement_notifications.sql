-- ============================================================
-- 079_engagement_notifications.sql — activity-gated auto-fetch +
-- new-jobs email notifications
-- ============================================================
-- Adds:
--   user_engagement          — one row per user; last_seen_at drives the
--                               inactivity gate (14d warn / 30d pause),
--                               notify_new_jobs is the per-user email opt-out.
--   profile_pause_state      — marks a search_profile as auto-paused by the
--                               worker gate (reason: inactivity | subscription).
--                               Read-only to the user (RLS own-read); the
--                               resume flow deletes rows, the worker gate
--                               inserts them. Service-role writes only.
--   pending_job_notifications — queue of "N new jobs" batches saved by
--                               scheduled (auto) runs, drained by the
--                               15-minute notify sweep into one email per
--                               user per sweep window.
--   touch_user_engagement()  — SECURITY DEFINER RPC called by the dashboard
--                               layout on every authenticated page load
--                               (throttled to once/hour) to keep last_seen_at
--                               fresh without a service-role write from the
--                               browser.
--
-- Gate semantics (enforced in worker code, not SQL):
--   - inactive >= 14d  -> one warning email, run still proceeds
--   - inactive >= 30d  -> profile paused (is_active=false, schedule removed),
--                         run skipped BEFORE any Apify/LLM cost
--   - dead subscription (canceled/unpaid/incomplete_expired, or trialing
--     past trial_end + 24h grace) -> pause immediately regardless of activity
--
-- Manual runs are never gated by this table. See backend/worker/src/
-- notifications/gate.ts for the decision logic.
-- ============================================================

-- ── USER ENGAGEMENT ────────────────────────────────────────
create table if not exists public.user_engagement (
  user_id             uuid primary key references public.users(id) on delete cascade,
  last_seen_at        timestamptz not null default now(),
  inactivity_warned_at timestamptz,
  notify_new_jobs     boolean not null default true,
  updated_at          timestamptz not null default now()
);

-- ── PROFILE PAUSE STATE ────────────────────────────────────
create table if not exists public.profile_pause_state (
  profile_id  uuid primary key references public.search_profiles(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  reason      text not null check (reason in ('inactivity','subscription')),
  paused_at   timestamptz not null default now()
);

-- ── PENDING JOB NOTIFICATIONS ──────────────────────────────
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

-- ============================================================
-- touch_user_engagement() — bump last_seen_at, throttled to once/hour.
-- Called by the authenticated browser client (auth.uid()); SECURITY DEFINER
-- so it can write the row despite RLS restricting user_engagement writes to
-- service-role for every column except this narrow last_seen_at bump.
-- ============================================================
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

-- ============================================================
-- Backfill — one row per existing user so the gate has a baseline.
-- ============================================================
insert into public.user_engagement (user_id, last_seen_at)
select u.id, now()
from public.users u
where not exists (
  select 1 from public.user_engagement ue where ue.user_id = u.id
)
on conflict (user_id) do nothing;

-- ============================================================
-- RLS
-- ============================================================
alter table public.user_engagement          enable row level security;
alter table public.profile_pause_state       enable row level security;
alter table public.pending_job_notifications enable row level security;

drop policy if exists user_engagement_own_read on public.user_engagement;
create policy user_engagement_own_read on public.user_engagement
  for select using (auth.uid() = user_id);

drop policy if exists user_engagement_own_update on public.user_engagement;
create policy user_engagement_own_update on public.user_engagement
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists profile_pause_state_own_read on public.profile_pause_state;
create policy profile_pause_state_own_read on public.profile_pause_state
  for select using (auth.uid() = user_id);

-- profile_pause_state has no user write policy — the worker gate (service-role)
-- inserts; the resume route (service-role, on the user's behalf) deletes.

-- pending_job_notifications: no user policies at all — service-role only
-- (worker writes on save, worker sweep reads/updates/deletes).

grant execute on function public.touch_user_engagement() to authenticated;
