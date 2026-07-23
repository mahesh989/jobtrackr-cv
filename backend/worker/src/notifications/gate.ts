// Activity-gated auto-fetch scheduling.
//
// Scheduled (trigger="auto") pipeline runs are gated by user activity so an
// abandoned account doesn't keep burning Apify/LLM cost forever:
//   - inactive >= WARN_AFTER_DAYS  -> one warning email, run still proceeds
//   - inactive >= PAUSE_AFTER_DAYS -> profile paused (is_active=false,
//     schedule removed), run skipped BEFORE any Apify/LLM cost
//   - dead subscription (canceled/unpaid/incomplete_expired, or trialing past
//     trial_end + TRIAL_GRACE_HOURS) -> pause immediately regardless of
//     activity, takes precedence over the activity checks
//
// Manual runs (trigger="manual") never call into this module — see the call
// site in pipeline/orchestrator.ts.
//
// decideGate() is a pure function (no Date.now() inside) so it's exhaustively
// unit-testable with explicit Dates — see gate.test.ts. applyGate() is the
// thin async wrapper that loads state, decides, and performs the DB/email
// side effects, with claim-based idempotency so two profiles belonging to
// the same user running in the same worker tick never double-pause or
// double-email.

import { db } from "../db/client.js";
import { removeProfileSchedule } from "../queue/scheduler.js";
import { Resend } from "resend";
const _resendApiKey = process.env.RESEND_API_KEY ?? "";
const resend = _resendApiKey ? new Resend(_resendApiKey) : null;
import { sendInactivityWarningEmail, sendPausedEmail } from "./engagementEmails.js";

export type GateAction =
  | { action: "run" }
  | { action: "warn_and_run" }
  | { action: "pause"; reason: "inactivity" | "subscription" };

export const WARN_AFTER_DAYS = 14;
export const PAUSE_AFTER_DAYS = 30;
export const TRIAL_GRACE_HOURS = 24;

const DEAD_STATUSES = new Set(["canceled", "unpaid", "incomplete_expired"]);

function isSubscriptionDead(
  subscription: { status: string; trial_end: string | null } | null,
  now: Date,
): boolean {
  // MISSING subscription row is NOT dead — pre-billing founder/beta users
  // have no row and must never be falsely paused. Any status other than the
  // explicit dead set (including past_due, which is Stripe still retrying
  // payment, and comp/active/incomplete/unexpired trialing) is NOT dead.
  if (!subscription) return false;

  if (DEAD_STATUSES.has(subscription.status)) return true;

  if (subscription.status === "trialing" && subscription.trial_end) {
    const graceEnd = new Date(new Date(subscription.trial_end).getTime() + TRIAL_GRACE_HOURS * 60 * 60 * 1000);
    return now > graceEnd;
  }

  return false;
}

export function decideGate(
  now: Date,
  engagement: { last_seen_at: string; inactivity_warned_at: string | null } | null,
  subscription: { status: string; trial_end: string | null } | null,
): GateAction {
  // Subscription check FIRST — takes precedence over the activity checks
  // (e.g. a user active today with a canceled subscription still gets paused).
  if (isSubscriptionDead(subscription, now)) {
    return { action: "pause", reason: "subscription" };
  }

  // Unknown engagement (row not yet created) is treated as active — the
  // caller creates the row on first touch; nothing to gate on yet.
  if (!engagement) {
    return { action: "run" };
  }

  const lastSeen = new Date(engagement.last_seen_at);
  const inactiveDays = (now.getTime() - lastSeen.getTime()) / (1000 * 60 * 60 * 24);

  if (inactiveDays >= PAUSE_AFTER_DAYS) {
    return { action: "pause", reason: "inactivity" };
  }

  if (inactiveDays >= WARN_AFTER_DAYS) {
    const warnedAt = engagement.inactivity_warned_at ? new Date(engagement.inactivity_warned_at) : null;
    // Re-eligible for a warning once the user has returned (last_seen_at
    // moved past the previous warning) and then gone idle again.
    if (!warnedAt || warnedAt < lastSeen) {
      return { action: "warn_and_run" };
    }
  }

  return { action: "run" };
}

interface EngagementRow {
  last_seen_at: string;
  inactivity_warned_at: string | null;
}
interface SubscriptionRow {
  status: string;
  trial_end: string | null;
}

/**
 * Orchestration wrapper — loads state, decides, and performs the necessary
 * DB writes + email sends. Returns { proceed: false } when the caller
 * (pipeline/orchestrator.ts) must skip the run entirely, before any
 * Apify/LLM cost is incurred.
 */
export async function applyGate(profileId: string, userId: string): Promise<{ proceed: boolean }> {
  const { data: engagementRow } = await db
    .from("user_engagement")
    .select("last_seen_at, inactivity_warned_at")
    .eq("user_id", userId)
    .maybeSingle();

  let engagement = engagementRow as EngagementRow | null;

  if (!engagement) {
    // First time we've seen this user in the gate — create a baseline row so
    // future runs have something to compare against, and treat this run as
    // active (decideGate already returns "run" for null engagement, but do
    // the insert regardless so the row exists next time).
    await db
      .from("user_engagement")
      .insert({ user_id: userId })
      .select("last_seen_at, inactivity_warned_at")
      .maybeSingle();
    // Not re-read — decideGate(null, ...) below already resolves to "run".
  }

  const { data: subscriptionRow } = await db
    .from("subscriptions")
    .select("status, trial_end")
    .eq("user_id", userId)
    .maybeSingle();

  const subscription = subscriptionRow as SubscriptionRow | null;

  const decision = decideGate(new Date(), engagement, subscription);

  if (decision.action === "run") {
    return { proceed: true };
  }

  if (decision.action === "warn_and_run") {
    // Claim the warn before emailing to prevent a double-send when two
    // profiles owned by the same user run in the same tick.
    const lastSeenIso = engagement!.last_seen_at;
    const { data: claimed } = await db
      .from("user_engagement")
      .update({ inactivity_warned_at: new Date().toISOString() })
      .eq("user_id", userId)
      .or(`inactivity_warned_at.is.null,inactivity_warned_at.lt.${lastSeenIso}`)
      .select("user_id");

    if (claimed && claimed.length > 0) {
      if (!resend) {
        console.log(`[gate] would send inactivity warning to user ${userId} (RESEND_API_KEY unset — skipping)`);
      } else {
        try {
          await sendInactivityWarningEmail(userId);
        } catch (err) {
          console.error(`[gate] failed to send inactivity warning to user ${userId}:`, err);
        }
      }
    }

    return { proceed: true };
  }

  // decision.action === "pause"
  const { data: claimedPause } = await db
    .from("profile_pause_state")
    .upsert(
      { profile_id: profileId, user_id: userId, reason: decision.reason },
      { onConflict: "profile_id", ignoreDuplicates: true },
    )
    .select("profile_id");

  // Regardless of claim outcome, the profile must end up paused — another
  // concurrent run may have already flipped is_active, this is idempotent.
  try {
    await db.from("search_profiles").update({ is_active: false }).eq("id", profileId);
  } catch (err) {
    console.error(`[gate] failed to deactivate profile ${profileId}:`, err);
  }

  try {
    await removeProfileSchedule(profileId);
  } catch (err) {
    console.error(`[gate] failed to remove schedule for profile ${profileId}:`, err);
  }

  // Only the claimer (the run that actually inserted the pause row) sends the
  // pause email — an empty array back from the upsert means another
  // concurrent run already claimed it.
  if (claimedPause && claimedPause.length > 0) {
    if (!resend) {
      console.log(`[gate] would send pause email to user ${userId} (RESEND_API_KEY unset — skipping)`);
    } else {
      try {
        await sendPausedEmail(userId, decision.reason);
      } catch (err) {
        console.error(`[gate] failed to send pause email to user ${userId}:`, err);
      }
    }
  }

  return { proceed: false };
}
