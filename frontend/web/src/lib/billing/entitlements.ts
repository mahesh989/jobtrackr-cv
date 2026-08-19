/**
 * Billing entitlement layer — the single server-side authority for "can this
 * user do X right now?". Used by the 4 choke points (createProfile, run,
 * analyze, cover-letter) and the billing UI.
 *
 * Resolution order:
 *   - role founder/admin            → full access, unlimited (no Stripe needed)
 *   - status 'comp'  & not expired  → full access, unlimited (grandfathered)
 *   - status 'trialing'             → full access, TRIAL limits, trial window
 *   - status 'active'               → full access, plan limits
 *   - status 'past_due'             → full access (dunning), plan limits + banner
 *   - canceled/unpaid/incomplete/no-row/comp-expired → READ-ONLY (block writes)
 *
 * Limits are DB-authoritative (the `plans` table) so caps can be tuned without
 * a deploy; PLAN_LIMITS is a typed fallback.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { ADMIN_ROLES } from "@/lib/constants";
import {
  PLAN_LIMITS,
  type PlanId,
  type SubStatus,
  type PlanLimits,
  type DenyReason,
} from "./plans";

type AccessMode = "full" | "read_only";

export interface Entitlement {
  userId: string;
  role: string;
  planId: PlanId;
  status: SubStatus | "none";
  access: AccessMode;
  unlimited: boolean;
  pastDue: boolean;
  limits: PlanLimits;
  periodStart: string | null; // ISO; null only for read-only/no-sub
  periodEnd: string | null;
  trialEnd: string | null;
}

export interface ConsumeResult {
  allowed: boolean;
  reason?: DenyReason;
  eventId?: string;
  requestConflict?: boolean;
  alreadyCommitted?: boolean;
}

const UNLIMITED: PlanLimits = {
  maxProfiles: null, maxRuns: null,
  maxCvUnique: null, maxCvTotal: null, maxLetterUnique: null, maxLetterTotal: null,
};

/** Load + resolve the user's entitlement. Always pass an authenticated id. */
export async function getEntitlement(userId: string): Promise<Entitlement> {
  const admin = createAdminClient();

  // Fetch user role + subscription in parallel — saves ~400ms avg vs sequential.
  const [
    { data: userRow, error: userErr },
    { data: sub, error: subErr },
  ] = await Promise.all([
    admin.from("users").select("role").eq("id", userId).maybeSingle(),
    admin
      .from("subscriptions")
      .select("plan_id, status, current_period_start, current_period_end, trial_end")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);
  // Both `error`s were silently discarded until 2026-08-09. A query failure
  // (bad/expired SUPABASE_SERVICE_ROLE_KEY, transient DB blip, anything) left
  // userRow/sub both null — indistinguishable from "this account genuinely has
  // no role or subscription yet". That sent a real founder/paying account
  // through the exact same path as a brand-new signup: role fell back to
  // 'beta', the ADMIN_ROLES bypass below never got a chance to fire, and
  // `!sub` below returned status:'none' — the dashboard layout's gate then
  // redirected a confirmed-active, confirmed-founder account to
  // /onboarding/plan, with zero visibility into why. Logging here doesn't
  // change the fail-closed behavior (this file's own convention for billing
  // safety — see rpcConsume's comment), but a silent paywall outage with no
  // error anywhere is worse than a loud one.
  if (userErr) console.error(`[entitlements] users query failed for ${userId}:`, userErr.message);
  if (subErr)  console.error(`[entitlements] subscriptions query failed for ${userId}:`, subErr.message);
  const role = (userRow as { role?: string } | null)?.role ?? "beta";

  // Founder/admin bypass everything.
  if ((ADMIN_ROLES as readonly string[]).includes(role)) {
    return {
      userId, role, planId: "comp", status: "comp", access: "full",
      unlimited: true, pastDue: false, limits: UNLIMITED,
      periodStart: null, periodEnd: null, trialEnd: null,
    };
  }

  const now = Date.now();
  const readOnly = (planId: PlanId, status: SubStatus | "none"): Entitlement => ({
    userId, role, planId, status, access: "read_only",
    unlimited: false, pastDue: false, limits: UNLIMITED,
    periodStart: null, periodEnd: null, trialEnd: null,
  });

  if (!sub) return readOnly("trial", "none");

  const s = sub as {
    plan_id: PlanId | null;
    status: SubStatus;
    current_period_start: string | null;
    current_period_end: string | null;
    trial_end: string | null;
  };
  const periodEndMs = s.current_period_end ? Date.parse(s.current_period_end) : null;

  // comp (grandfathered / admin) — full until period end, then read-only.
  if (s.status === "comp") {
    if (periodEndMs && now > periodEndMs) return readOnly("comp", "comp");
    return {
      userId, role, planId: "comp", status: "comp", access: "full",
      unlimited: true, pastDue: false, limits: UNLIMITED,
      periodStart: s.current_period_start, periodEnd: s.current_period_end,
      trialEnd: s.trial_end,
    };
  }

  // Active-ish states get write access.
  if (s.status === "trialing" || s.status === "active" || s.status === "past_due") {
    // During the trial, enforce TRIAL caps regardless of the chosen plan.
    const effectivePlan: PlanId = s.status === "trialing" ? "trial" : (s.plan_id ?? "trial");
    const limits = await loadLimits(effectivePlan);
    const unlimited =
      limits.maxCvUnique === null && limits.maxLetterUnique === null &&
      limits.maxProfiles === null && limits.maxRuns === null;
    return {
      userId, role, planId: effectivePlan, status: s.status, access: "full",
      unlimited, pastDue: s.status === "past_due", limits,
      periodStart: s.current_period_start, periodEnd: s.current_period_end,
      trialEnd: s.trial_end,
    };
  }

  // canceled / unpaid / incomplete / incomplete_expired → read-only.
  return readOnly(s.plan_id ?? "trial", s.status);
}

/** DB-authoritative limits with a typed fallback. */
async function loadLimits(planId: PlanId): Promise<PlanLimits> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("plans")
    .select("max_profiles, max_runs, max_cv_unique, max_cv_total, max_letter_unique, max_letter_total")
    .eq("id", planId)
    .maybeSingle();
  if (!data) return PLAN_LIMITS[planId] ?? PLAN_LIMITS.trial;
  const d = data as Record<string, number | null>;
  return {
    maxProfiles: d.max_profiles,
    maxRuns: d.max_runs,
    maxCvUnique: d.max_cv_unique,
    maxCvTotal: d.max_cv_total,
    maxLetterUnique: d.max_letter_unique,
    maxLetterTotal: d.max_letter_total,
  };
}

// ── Choke-point helpers ─────────────────────────────────────────────────────

/** Profile cap = live count of search_profiles (delete frees a slot). */
export async function assertCanCreateProfile(userId: string): Promise<ConsumeResult> {
  const ent = await getEntitlement(userId);
  if (ent.access === "read_only") return { allowed: false, reason: "no_subscription" };
  if (ent.limits.maxProfiles === null) return { allowed: true };

  const admin = createAdminClient();
  const { count } = await admin
    .from("search_profiles")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if ((count ?? 0) >= ent.limits.maxProfiles) return { allowed: false, reason: "profile_cap" };
  return { allowed: true };
}

/** Reserve a run credit, idempotently keyed by the browser request UUID. */
export async function consumeRun(
  userId: string,
  requestId: string,
  profileId: string,
  fullRefresh: boolean,
): Promise<ConsumeResult> {
  const ent = await getEntitlement(userId);
  if (ent.access === "read_only") return { allowed: false, reason: "no_subscription" };
  if (ent.limits.maxRuns !== null && ent.periodStart) {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("reserve_run_usage", {
      p_user: userId,
      p_request: requestId,
      p_profile: profileId,
      p_full_refresh: fullRefresh,
      p_max_total: ent.limits.maxRuns,
      p_period_start: ent.periodStart,
    });
    if (error) {
      console.error("[entitlements] reserve_run_usage error:", error.message);
      // The database may have committed before the HTTP acknowledgement was
      // lost. Let the route return 503 so the browser keeps this request UUID.
      throw new Error(`run usage reservation uncertain: ${error.message}`);
    }
    const row = Array.isArray(data) ? data[0] : data;
    const res = {
      allowed: !!row?.allowed,
      reason: row?.reason ?? "error",
      eventId: row?.event_id ?? undefined,
    };
    if (!res.allowed) {
      return {
        allowed: false,
        reason: "run_cap",
        requestConflict: res.reason === "request_conflict",
      };
    }
    return res.reason === "existing_committed"
      ? { allowed: true, eventId: res.eventId, alreadyCommitted: true }
      : { allowed: true, eventId: res.eventId };
  }
  return { allowed: true };
}

/** Reserve a tailored-CV credit. Caller must linkUsageEvent() to the run id. */
export async function consumeTailoredCv(userId: string, jobId: string): Promise<ConsumeResult> {
  const ent = await getEntitlement(userId);
  if (ent.access === "read_only") return { allowed: false, reason: "no_subscription" };
  if (ent.unlimited || ent.periodStart === null) return { allowed: true };
  const res = await rpcConsume(
    userId, "tailored_cv", jobId, ent.limits.maxCvUnique, ent.limits.maxCvTotal, ent.periodStart,
  );
  if (!res.allowed) {
    return { allowed: false, reason: res.reason === "unique_cap" ? "cv_unique_cap" : "cv_total_cap" };
  }
  return { allowed: true, eventId: res.eventId };
}

/** Reserve a cover-letter credit. Caller must linkUsageEvent() to the letter id. */
export async function consumeCoverLetter(userId: string, jobId: string): Promise<ConsumeResult> {
  const ent = await getEntitlement(userId);
  if (ent.access === "read_only") return { allowed: false, reason: "no_subscription" };
  if (ent.unlimited || ent.periodStart === null) return { allowed: true };
  const res = await rpcConsume(
    userId, "cover_letter", jobId, ent.limits.maxLetterUnique, ent.limits.maxLetterTotal, ent.periodStart,
  );
  if (!res.allowed) {
    return { allowed: false, reason: res.reason === "unique_cap" ? "letter_unique_cap" : "letter_total_cap" };
  }
  return { allowed: true, eventId: res.eventId };
}

// ── Reservation lifecycle ───────────────────────────────────────────────────

/**
 * Link a pending reservation to the artifact row so triggers can commit/void
 * it. C67: this update's result — including any error — used to be
 * discarded entirely, unlike every sibling in this reservation lifecycle
 * (release/commit both check and throw below). A silent failure here left
 * the reservation stuck "pending" with no ref_id forever: the commit/void
 * trigger keys off ref_id, so it would never fire, and if pending
 * reservations count toward the usage cap (they do — that's the point of
 * reserving before consuming), this silently and permanently burns one of
 * the user's credits for nothing.
 */
export async function linkUsageEvent(eventId: string, refId: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("usage_events").update({ ref_id: refId }).eq("id", eventId);
  if (error) throw new Error(`usage event link failed: ${error.message}`);
}

/** Void a reservation when the action fails before the artifact row exists. */
export async function releaseUsageEvent(eventId: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("usage_events")
    .update({ status: "voided" }).eq("id", eventId).eq("status", "pending");
  if (error) throw new Error(`usage event release failed: ${error.message}`);
}

/** Commit a pending reservation after its paid action has started successfully. */
export async function commitUsageEvent(eventId: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("usage_events")
    .update({ status: "committed" }).eq("id", eventId).eq("status", "pending");
  if (error) throw new Error(`usage event commit failed: ${error.message}`);
}

/** Commit a run reservation, failing if it was voided/missing/wrong-kind. */
export async function commitRunUsageEvent(eventId: string): Promise<void> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("commit_run_usage", { p_event: eventId });
  if (error) throw new Error(`run usage commit failed: ${error.message}`);
  if (data !== true) throw new Error("run usage commit failed: event is not pending or committed");
}

async function rpcConsume(
  userId: string,
  kind: "tailored_cv" | "cover_letter" | "run",
  jobId: string | null,
  maxUnique: number | null,
  maxTotal: number | null,
  periodStart: string,
): Promise<{ allowed: boolean; reason: string; eventId?: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("consume_usage", {
    p_user: userId,
    p_kind: kind,
    p_job: jobId,
    p_max_unique: maxUnique,
    p_max_total: maxTotal,
    p_period_start: periodStart,
  });
  if (error) {
    console.error("[entitlements] consume_usage error:", error.message);
    // Fail CLOSED on metered actions — a billing-meter outage must not give
    // away unlimited paid work. (Contrast with rateLimit which fails open.)
    return { allowed: false, reason: "error" };
  }
  const row = Array.isArray(data) ? data[0] : data;
  return {
    allowed: !!row?.allowed,
    reason: row?.reason ?? "error",
    eventId: row?.event_id ?? undefined,
  };
}

// ── Usage summary (billing UI meters) ───────────────────────────────────────

export interface UsageSummary {
  cvUnique: number; cvTotal: number;
  letterUnique: number; letterTotal: number;
  runs: number; profiles: number;
}

export async function getUsageSummary(userId: string, periodStart: string | null): Promise<UsageSummary> {
  const admin = createAdminClient();
  const empty: UsageSummary = { cvUnique: 0, cvTotal: 0, letterUnique: 0, letterTotal: 0, runs: 0, profiles: 0 };

  const { count: profiles } = await admin
    .from("search_profiles").select("id", { count: "exact", head: true }).eq("user_id", userId);
  empty.profiles = profiles ?? 0;
  if (!periodStart) return empty;

  // Active events = committed OR pending within the last hour.
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: rows } = await admin
    .from("usage_events")
    .select("kind, job_id, status, created_at")
    .eq("user_id", userId)
    .eq("period_start", periodStart);

  const active = ((rows ?? []) as Array<{ kind: string; job_id: string | null; status: string; created_at: string }>)
    .filter((r) => r.status === "committed" || (r.status === "pending" && r.created_at > cutoff));

  const uniqJobs = (kind: string) =>
    new Set(active.filter((r) => r.kind === kind && r.job_id).map((r) => r.job_id)).size;
  const total = (kind: string) => active.filter((r) => r.kind === kind).length;

  return {
    cvUnique: uniqJobs("tailored_cv"),
    cvTotal: total("tailored_cv"),
    letterUnique: uniqJobs("cover_letter"),
    letterTotal: total("cover_letter"),
    runs: total("run"),
    profiles: profiles ?? 0,
  };
}
