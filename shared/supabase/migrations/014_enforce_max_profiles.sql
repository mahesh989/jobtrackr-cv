-- ============================================================
-- 014_enforce_max_profiles.sql
--
-- C67 (execution chunk C67, pipeline/schema/security section):
-- search_profiles' RLS INSERT policy (profiles_insert_own, 002_rls.sql)
-- only ever checked `user_id = auth.uid()` — no cap. The app's own
-- billing gate (assertCanCreateProfile, frontend/web/src/lib/billing/
-- entitlements.ts) protects the official createProfile server action,
-- but that action inserts via the user's own RLS-scoped Supabase client
-- (authedClient(), not service-role) — so a user calling Supabase's
-- PostgREST API directly with their own session JWT, bypassing the
-- Next.js app entirely, could INSERT unlimited search_profiles rows
-- regardless of plan tier. Same bypass shape as the historical C3
-- "unlimited free artifacts" finding this project's audit already
-- fixed elsewhere.
--
-- Fix: a BEFORE INSERT trigger that re-derives the SAME entitlement
-- decision entitlements.ts's getEntitlement()/assertCanCreateProfile()
-- make, at the DB layer, so the cap holds regardless of which client
-- performs the insert. Mirrors (does not call — no cross-language RPC
-- exists) that TypeScript logic function-for-function:
--   - founder/admin role (ADMIN_ROLES, frontend/web/src/lib/constants.ts)
--     -> unlimited, matches getEntitlement's role bypass.
--   - subscriptions.status = 'comp', not expired -> unlimited, matches
--     getEntitlement's comp branch.
--   - status in ('trialing','active','past_due') -> resolve the
--     effective plan (trialing forces the 'trial' plan's caps
--     regardless of plan_id, exactly like getEntitlement's
--     `effectivePlan` ternary) and enforce plans.max_profiles.
--   - no subscription row, or any other status (canceled/unpaid/
--     incomplete/incomplete_expired/comp-expired) -> read-only in the
--     app (assertCanCreateProfile's `access === "read_only"` check) ->
--     block ALL new profile inserts.
--   - plans.max_profiles IS NULL -> unlimited plan, matches
--     assertCanCreateProfile's `limits.maxProfiles === null` check.
--   - a missing plans row (shouldn't happen; seeded in 003_seed.sql)
--     falls back to the SAME per-plan value as plans.ts's PLAN_LIMITS
--     constant (loadLimits()'s own fallback when it finds no row).
--   - is_manual=true (the one-per-user, non-deletable, always-available
--     "Saved Jobs" auto-provisioned container — see the column comment
--     on search_profiles.is_manual, 001_full_schema.sql, and
--     getOrCreateManualProfile() in frontend/web/src/lib/actions/
--     profiles.ts) is EXEMPT entirely, matching the app's own behavior:
--     that insert has no billing gate today (not a billable search
--     profile), and its caller has no try/catch around it — without
--     this exemption, any capped or read-only user's first "Add Job"
--     click would hard-fail on a feature the app documents as always
--     available. Caught in review before this migration was applied.
--
-- SECURITY DEFINER + explicit search_path: this trigger's reads
-- (public.users, public.subscriptions, public.plans) are all readable
-- by a user for their own row under existing RLS policies (users_
-- select_own, subscriptions_own_read, plans_public_read — all already
-- live per 002_rls.sql), so a plain trigger would work for the
-- exact case this fix targets. SECURITY DEFINER is used anyway to
-- give a definitive answer independent of those policies' current or
-- future shape, matching this repo's established convention for
-- gate/enforcement functions (see consume_usage, 001_full_schema.sql).
--
-- Additive only, per CLAUDE.md Non-Negotiable #6: new function + new
-- trigger, no ALTER of any existing table/column/policy.
-- ============================================================

create or replace function public.enforce_max_profiles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role          text;
  v_status        text;
  v_plan_id       text;
  v_period_end    timestamptz;
  v_effective_plan text;
  v_max_profiles  int;
  v_current_count int;
begin
  -- Saved Jobs auto-provisioning is never plan-gated in app code — see
  -- getOrCreateManualProfile() (frontend/web/src/lib/actions/profiles.ts),
  -- which has no billing gate and no try/catch around this insert.
  if new.is_manual then
    return new;
  end if;

  -- Founder/admin bypass — matches entitlements.ts's ADMIN_ROLES check.
  select role into v_role from public.users where id = new.user_id;
  if v_role in ('founder', 'admin') then
    return new;
  end if;

  select status, plan_id, current_period_end
    into v_status, v_plan_id, v_period_end
    from public.subscriptions
    where user_id = new.user_id;

  if not found then
    -- No subscription row at all -> getEntitlement's `!sub` branch ->
    -- read_only -> assertCanCreateProfile denies with "no_subscription".
    raise exception 'profile creation blocked: no active subscription for user %', new.user_id
      using errcode = 'P0001';
  end if;

  if v_status = 'comp' then
    if v_period_end is not null and v_period_end < now() then
      raise exception 'profile creation blocked: comp subscription expired for user %', new.user_id
        using errcode = 'P0001';
    end if;
    return new;  -- comp, not expired -> unlimited (matches UNLIMITED limits).
  end if;

  if v_status not in ('trialing', 'active', 'past_due') then
    -- canceled/unpaid/incomplete/incomplete_expired -> read_only -> block.
    raise exception 'profile creation blocked: subscription status % is read-only for user %', v_status, new.user_id
      using errcode = 'P0001';
  end if;

  -- Trialing forces trial-tier caps regardless of the chosen plan_id,
  -- exactly like getEntitlement's `effectivePlan` ternary.
  v_effective_plan := case when v_status = 'trialing' then 'trial' else coalesce(v_plan_id, 'trial') end;

  select max_profiles into v_max_profiles from public.plans where id = v_effective_plan;
  if not found then
    -- Fallback matching PLAN_LIMITS (frontend/web/src/lib/billing/plans.ts)
    -- for the case plans has no row for this id — per-plan, not a single
    -- hardcoded value, so a missing 'unlimited'/'weekly'/'monthly' row
    -- doesn't wrongly fall back to trial's cap of 1.
    v_max_profiles := case v_effective_plan
      when 'trial'     then 1
      when 'weekly'    then 5
      when 'monthly'   then 10
      when 'unlimited' then null
      else 1  -- unrecognised plan id — PLAN_LIMITS.trial's own fallback.
    end;
  end if;

  if v_max_profiles is null then
    return new;  -- unlimited plan (weekly/monthly's null, or unlimited/comp tier).
  end if;

  select count(*) into v_current_count from public.search_profiles where user_id = new.user_id;

  if v_current_count >= v_max_profiles then
    raise exception 'profile creation blocked: user % already has % of % profiles (plan %)',
      new.user_id, v_current_count, v_max_profiles, v_effective_plan
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_max_profiles_trigger on public.search_profiles;
create trigger enforce_max_profiles_trigger
  before insert on public.search_profiles
  for each row execute function public.enforce_max_profiles();
