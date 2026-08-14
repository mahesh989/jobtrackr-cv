-- ============================================================
-- JobTrackr-CV — 011_stripe_events_claim_status.sql
-- Apply standalone (no other migrations depend on this).
--
-- Durable fix for BUG-25 (F3 + F4, .claude/graph.json known_issues),
-- execution chunk C6b. Both residuals stem from the SAME root cause:
-- webhookIdempotency.ts's claim = INSERT, release = DELETE design has no
-- forensic trace and no ownership token.
--
--   F3 — a genuinely CONCURRENT duplicate delivery for the same Stripe
--   event_id (not a sequential retry) always gets a 200 ack on its
--   "duplicate" branch regardless of whether the FIRST delivery's handler
--   ultimately succeeds or fails. If the first one fails and releases
--   (deletes) the row, the event is now silently unprocessed with zero
--   trace it was ever attempted — Stripe already saw a 200 for that
--   event_id from the second delivery and will not retry.
--
--   F4 — release() is `DELETE FROM stripe_events WHERE event_id = $1`,
--   with no ownership token distinguishing "the claim I made" from "a
--   claim someone else made after mine." A specific interleaving (this
--   release() racing a genuinely-new delivery of the same event_id that
--   claims right as the row is deleted) is a bounded-impact but real
--   race.
--
-- Fix: replace insert/delete with an explicit status column
-- (pending/succeeded/failed), a claimed_at staleness clock, and a
-- per-claim claim_token — and move the claim decision into a single
-- atomic RPC that locks the row (`select ... for update`) for the
-- duration of the decision.
--
-- Round 2 (independent Opus review, execution chunk C6b): round 1 of this
-- migration closed F4 for the CLAIM decision itself but round 1's APP
-- CODE (stripeEventStore.ts) discarded this function's prior_status
-- return value and collapsed "already succeeded" and "still genuinely
-- in-flight" into the same "duplicate -> 200 ack" response — which is
-- F3, verbatim, still open. Fixing that on the app side requires this
-- function to hand back enough information to distinguish the two AND an
-- unforgeable claim_token so a caller that no longer holds the current
-- claim can't stamp status over a newer claimant's row (closing F4 for
-- markSucceeded/markFailed, not just claim). Both added here.
--
-- Additive only, per CLAUDE.md's Non-Negotiable #6: ADD COLUMN (not DROP/
-- RENAME/TYPE-change) on stripe_events, plus one new function. No
-- existing column, constraint, or row is altered; the 3 pre-existing
-- columns (event_id, type, processed_at) are untouched and still written
-- exactly as before.

alter table public.stripe_events
  add column if not exists claimed_at timestamptz,
  add column if not exists claim_token uuid,
  add column if not exists status text not null default 'pending'
    check (status in ('pending', 'succeeded', 'failed'));

-- Backfill: every pre-existing row is a webhook event that was already
-- fully processed under the old insert-once design (if it existed at
-- all, the handler ran to completion — the old design deleted the row on
-- failure, so a surviving row was never a failure). Mark them succeeded
-- so claim_stripe_event's staleness/failed-retry paths never mistakenly
-- reprocess historical events.
--
-- Time-bounded (processed_at older than 10 minutes), NOT a blanket
-- backfill (migration-checker review): if this migration is applied
-- while the OLD route.ts is still live mid-deploy, a webhook that is
-- genuinely in-flight at that instant would otherwise get mislabeled
-- 'succeeded' before its handler has actually finished. A very-recent
-- row is left 'pending' with claimed_at = processed_at instead — it
-- self-heals via claim_stripe_event's own staleness window exactly like
-- any other abandoned claim, rather than relying on a point-in-time
-- assumption about what's still running. claimed_at is set in BOTH
-- branches: leaving it null on the 'pending' branch would make those
-- rows permanently unreclaimable (`claimed_at < now() - p_stale_after`
-- is never true when claimed_at is null). claim_token is left null on
-- both branches -- nothing holds a live claim on a backfilled row, so
-- there is no token to forge yet; the reclaim path below always mints a
-- fresh one before any caller could act on it.
update public.stripe_events
set
  status = case
    when processed_at < now() - interval '10 minutes' then 'succeeded'
    else 'pending'
  end,
  claimed_at = processed_at
where status = 'pending' and claimed_at is null;

-- ============================================================
-- claim_stripe_event() — atomic, row-locked claim decision.
--
-- Returns:
--   claimed = true  -> caller must run the handler. claim_token is this
--                       claim's ownership token -- the caller must include
--                       it (as `.eq("claim_token", token)`) on its later
--                       status-write UPDATE, so a stale caller that has
--                       since lost the claim (reclaimed by someone else
--                       after this one went stale) can't stamp status
--                       over a newer claim's row. See stripeEventStore.ts.
--   claimed = false, prior_status = 'succeeded'
--                    -> a TRUE duplicate. Safe to 200-ack Stripe and do
--                       nothing further.
--   claimed = false, prior_status = 'pending'
--                    -> a genuinely CONCURRENT duplicate delivery whose
--                       original claim is still fresh (this is exactly
--                       what F3 needs distinguished from the case above
--                       -- the caller must NOT 200-ack this one, since
--                       the in-flight attempt might still fail with no
--                       further Stripe retry to catch it. Return a
--                       non-2xx so Stripe retries again later.
--
-- p_stale_after governs both correctness (F3: too short reclaims a
-- genuinely-in-flight claim and risks two concurrent handler runs) and
-- recovery latency (F4/round-1 finding: too long strands an event whose
-- claimer died with no mark for that long). Caller is expected to pass
-- this explicitly, sized just above its own execution time cap --
-- see stripeEventStore.ts. The 5-minute default here is a safe fallback
-- only, not a tuned value.
-- ============================================================
-- DROP first: this function's signature changed shape mid-development
-- (RETURNS TABLE gained claim_token) — Postgres refuses CREATE OR REPLACE
-- across a return-type change ("cannot change return type of existing
-- function"), so a plain CREATE OR REPLACE would hard-fail if applied
-- against a database that already ran an earlier version of this same
-- file (round-2 independent review, N1). IF EXISTS keeps this re-runnable
-- against a database that never saw this migration at all.
drop function if exists public.claim_stripe_event(text, text, interval);

create or replace function public.claim_stripe_event(
  p_event_id    text,
  p_type        text,
  p_stale_after interval default interval '5 minutes'
)
returns table (claimed boolean, prior_status text, claim_token uuid)
language plpgsql
security definer set search_path = public
as $$
declare
  v_status      text;
  v_claimed_at  timestamptz;
  v_claim_token uuid;
begin
  -- Row lock closes F4 for an EXISTING row: whichever transaction gets
  -- here first holds it until commit, so a second concurrent caller
  -- BLOCKS here rather than racing on a bare INSERT/DELETE with no
  -- defined ordering.
  select status, claimed_at into v_status, v_claimed_at
  from public.stripe_events
  where event_id = p_event_id
  for update;

  if not found then
    v_claim_token := gen_random_uuid();
    insert into public.stripe_events (event_id, type, status, claimed_at, claim_token)
    values (p_event_id, p_type, 'pending', now(), v_claim_token)
    on conflict (event_id) do nothing;

    if found then
      -- FOUND reflects the INSERT: true only if a row was actually
      -- inserted (ON CONFLICT DO NOTHING sets it false when skipped).
      return query select true, null::text, v_claim_token;
      return;
    end if;

    -- Lost the race: a concurrent caller inserted this event_id between
    -- our first SELECT ... FOR UPDATE (found nothing) and this INSERT
    -- (just conflicted). Re-acquire the lock -- the row now exists and is
    -- held by the winner until its transaction commits, so this blocks
    -- until then -- and fall through to the normal decision logic below
    -- instead of raising a unique-violation.
    select status, claimed_at into v_status, v_claimed_at
    from public.stripe_events
    where event_id = p_event_id
    for update;
  end if;

  if v_status = 'succeeded' then
    return query select false, 'succeeded'::text, null::uuid;
    return;
  end if;

  if v_status = 'failed' or (v_status = 'pending' and v_claimed_at < now() - p_stale_after) then
    -- A prior attempt failed, or a prior claim went stale (its process
    -- died without ever marking succeeded/failed) -- safe to reclaim and
    -- retry. A FRESH claim_token invalidates the previous claimant's
    -- token, so if that dead claimant somehow wakes up and issues its
    -- own status-write UPDATE with its old token, the
    -- `where claim_token = $token` predicate matches zero rows instead of
    -- clobbering this new claim's status. type is refreshed in case
    -- Stripe's retry carries updated metadata (it doesn't in practice,
    -- but nothing here assumes it).
    v_claim_token := gen_random_uuid();
    update public.stripe_events
    set status = 'pending', claimed_at = now(), claim_token = v_claim_token, type = p_type
    where event_id = p_event_id;
    return query select true, v_status, v_claim_token;
    return;
  end if;

  if v_status = 'pending' then
    -- Still within the staleness window: a genuinely concurrent
    -- duplicate delivery of the SAME event_id, with the original claim's
    -- handler still plausibly in-flight. Do not reclaim, and do not
    -- report this the same way as a true 'succeeded' duplicate -- the
    -- caller must keep Stripe retrying rather than 200-ack an event that
    -- might still fail with nothing left to catch it (F3).
    return query select false, 'pending'::text, null::uuid;
    return;
  end if;

  -- Unreachable in practice (status is constrained to pending/succeeded/
  -- failed and every branch above is exhaustive over those three), but a
  -- money path should never silently fail closed on an unexpected state
  -- -- default to claimable rather than default to "duplicate, ack and
  -- drop it" (independent review, round 2, finding #6).
  v_claim_token := gen_random_uuid();
  update public.stripe_events
  set status = 'pending', claimed_at = now(), claim_token = v_claim_token, type = p_type
  where event_id = p_event_id;
  return query select true, v_status, v_claim_token;
end;
$$;

revoke execute on function public.claim_stripe_event(text, text, interval)
  from public, anon, authenticated;

-- No RPC function for the status writes: closing F4 for claim() alone
-- (round 1) was not sufficient, since an unconditional
-- `update ... where event_id = $1` from the app layer has the exact same
-- "no ownership token" defect the original release() had, just moved
-- from a DELETE to an UPDATE (independent review, round 2, finding #3).
-- Unlike claim()'s decision logic, a status write needs no additional
-- atomicity beyond what a single conditional UPDATE already gives for
-- free in Postgres -- stripeEventStore.ts issues a plain
-- `.update({status}).eq("event_id", id).eq("claim_token", token)` PostgREST
-- call directly. A caller whose claim has since gone stale and been
-- reclaimed by someone else affects zero rows (its token no longer
-- matches) instead of overwriting the newer claimant's status.

-- Rollback (two statements, run together — dropping the function also
-- drops its revoked grant, nothing else to undo there):
--   drop function if exists public.claim_stripe_event(text, text, interval);
--   alter table public.stripe_events drop column if exists claimed_at, drop column if exists claim_token, drop column if exists status;
