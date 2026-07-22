/**
 * Auto-analyze billing reservation — mirrors the tailored-CV choke point in
 * frontend/web/src/lib/billing/entitlements.ts so a pipeline-fetched job that
 * gets auto-tailored counts against the user's CV quota, exactly like the
 * manual Analyze button.
 *
 * The worker is a separate package and cannot import the web layer, so the
 * minimal entitlement resolution is duplicated here — same pattern the codebase
 * already uses for resolveThresholds() mirroring atsThresholds.ts. KEEP IN SYNC
 * with entitlements.ts + plans.ts + migration 051_billing.sql.
 *
 * Lifecycle (identical to the manual route):
 *   1. reserveTailoredCv() — atomic cap-check + a PENDING usage_event via the
 *      consume_usage RPC. Denied → caller skips the analysis entirely.
 *   2. After the analysis_runs row is inserted, linkCvUsageEvent(eventId, runId)
 *      sets usage_events.ref_id = run_id.
 *   3. The analysis_runs status trigger (migration 051) then COMMITS the event
 *      on status='completed' or VOIDS it on 'failed'.
 *   4. If the run row is never created, the caller voids the reservation with
 *      releaseCvUsageEvent().
 *
 * Founder/admin, comp, unlimited plans, and trial-with-no-period bypass
 * the meter (eventId = null → nothing to link/void). Fails CLOSED on RPC error.
 */
import { db } from "../db/client.js";

const ADMIN_ROLES = new Set(["founder", "admin"]);

// CV caps per plan — typed mirror of PLAN_LIMITS (plans.ts) / migration 051
// seed. null = unlimited for that dimension. Fallback only; the plans table is
// authoritative and read first.
const PLAN_CV_LIMITS: Record<string, { unique: number | null; total: number | null }> = {
  trial:     { unique: 3,    total: 3    },
  weekly:    { unique: 50,   total: 75   },
  monthly:   { unique: 250,  total: 375  },
  unlimited: { unique: null, total: null },
  comp:      { unique: null, total: null },
};

export interface CvReservation {
  allowed: boolean;
  reason?: string;
  /** null when the user bypasses the meter (admin/unlimited) — nothing to link/void. */
  eventId: string | null;
}

export async function reserveTailoredCv(userId: string, jobId: string): Promise<CvReservation> {
  // Founder/admin bypass everything.
  const { data: userRow } = await db.from("users").select("role").eq("id", userId).maybeSingle();
  const role = (userRow as { role?: string } | null)?.role ?? "beta";
  if (ADMIN_ROLES.has(role)) return { allowed: true, eventId: null };

  const { data: sub } = await db
    .from("subscriptions")
    .select("plan_id, status, current_period_start, current_period_end")
    .eq("user_id", userId)
    .maybeSingle();
  if (!sub) return { allowed: false, reason: "no_subscription", eventId: null };
  const s = sub as {
    plan_id: string | null;
    status: string;
    current_period_start: string | null;
    current_period_end: string | null;
  };

  // comp (grandfathered) — unlimited until period end, then read-only.
  if (s.status === "comp") {
    const endMs = s.current_period_end ? Date.parse(s.current_period_end) : null;
    if (endMs && Date.now() > endMs) return { allowed: false, reason: "no_subscription", eventId: null };
    return { allowed: true, eventId: null };
  }

  // Only active-ish states get write access; everything else is read-only.
  if (s.status !== "trialing" && s.status !== "active" && s.status !== "past_due") {
    return { allowed: false, reason: "no_subscription", eventId: null };
  }

  // Trial enforces TRIAL caps regardless of the chosen plan.
  const effectivePlan = s.status === "trialing" ? "trial" : (s.plan_id ?? "trial");
  const caps = await loadCvCaps(effectivePlan);

  // Unlimited plan, or no billing period to count against → no reservation.
  if ((caps.unique === null && caps.total === null) || !s.current_period_start) {
    return { allowed: true, eventId: null };
  }

  const { data, error } = await db.rpc("consume_usage", {
    p_user: userId,
    p_kind: "tailored_cv",
    p_job: jobId,
    p_max_unique: caps.unique,
    p_max_total: caps.total,
    p_period_start: s.current_period_start,
  });
  if (error) {
    // Fail CLOSED — a billing-meter outage must not give away paid work.
    console.error(`[auto-analyze] consume_usage error: ${error.message}`);
    return { allowed: false, reason: "error", eventId: null };
  }
  const row = Array.isArray(data) ? data[0] : data;
  return {
    allowed: !!row?.allowed,
    reason: (row?.reason as string | undefined) ?? undefined,
    eventId: (row?.event_id as string | undefined) ?? null,
  };
}

/** DB-authoritative CV caps with a typed PLAN_CV_LIMITS fallback. */
async function loadCvCaps(planId: string): Promise<{ unique: number | null; total: number | null }> {
  const { data } = await db
    .from("plans")
    .select("max_cv_unique, max_cv_total")
    .eq("id", planId)
    .maybeSingle();
  if (data) {
    const d = data as Record<string, number | null>;
    return { unique: d.max_cv_unique ?? null, total: d.max_cv_total ?? null };
  }
  return PLAN_CV_LIMITS[planId] ?? PLAN_CV_LIMITS.trial;
}

/** Link a pending reservation to the run row so the status trigger commits/voids it. */
export async function linkCvUsageEvent(eventId: string, runId: string): Promise<void> {
  await db.from("usage_events").update({ ref_id: runId }).eq("id", eventId);
}

/** Void a reservation when no run row will be created. */
export async function releaseCvUsageEvent(eventId: string): Promise<void> {
  await db.from("usage_events").update({ status: "voided" }).eq("id", eventId).eq("status", "pending");
}
