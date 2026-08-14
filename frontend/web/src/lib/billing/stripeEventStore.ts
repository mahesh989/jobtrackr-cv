/**
 * The real, Supabase-backed IdempotencyStore for the Stripe webhook route
 * (BUG-25 F3/F4, execution chunk C6b, 2 review rounds). Extracted out of
 * route.ts so the claim/mark logic is testable against a fake Supabase
 * client, matching this repo's established convention (see
 * checkoutDecision.ts, C7) of pulling I/O orchestration logic out of
 * route handlers.
 *
 * claim() delegates the actual dedupe decision to claim_stripe_event(), a
 * Postgres function that row-locks the stripe_events row for the
 * duration of the decision (migrations/011_stripe_events_claim_status.sql)
 * — that lock is what closes F4's claim race; nothing on the TS side can
 * replicate it, so claim() is intentionally a thin pass-through rather
 * than reimplementing any claim logic client-side.
 *
 * markSucceeded/markFailed do NOT need the same RPC treatment — a plain
 * conditional UPDATE is already atomic — but round 2's independent review
 * found the round-1 version of these (an unconditional
 * `.eq("event_id", id)`) had the exact same "no ownership token" defect
 * the original release() had. Both now additionally filter on
 * `.eq("claim_token", token)`, so a caller whose claim has since gone
 * stale and been reclaimed by a newer delivery affects zero rows instead
 * of overwriting that newer claim's status.
 */

import type { createAdminClient } from "@/lib/supabase/admin";
import type { IdempotencyStore } from "./webhookIdempotency";

type AdminClient = ReturnType<typeof createAdminClient>;

const _STRIPE_EVENTS = "stripe_events";

// Must exceed route.ts's own execution-time cap (maxDuration) with real
// margin, or a legitimately still-running handler can be misread as
// abandoned and reclaimed by a concurrent duplicate/retry before it's
// actually finished (independent review, round 2, finding #2 — the
// original 5-minute SQL default was ~20x route.ts's actual runtime, but
// nothing tied the two together, so a future maxDuration change could
// silently reopen this). route.ts sets maxDuration = 20; this is that
// plus generous margin, not a tuned-to-the-second value.
const STALE_AFTER = "45 seconds";

function isMissingOrForbiddenRpc(code: string | undefined): boolean {
  // PGRST202: function not found in PostgREST's schema cache (migration
  // not applied yet, or cache not reloaded after applying it).
  // 42883: undefined function. 42501: insufficient privilege (grants
  // misconfigured). All three mean claim_stripe_event() is NOT reachable
  // at all, not a business decision — distinct, louder log token from a
  // generic transient failure (independent review, round 2, finding #4).
  return code === "PGRST202" || code === "42883" || code === "42501";
}

export function createStripeEventStore(admin: AdminClient): IdempotencyStore {
  return {
    async claim(eventId, type) {
      const { data, error } = await admin.rpc("claim_stripe_event", {
        p_event_id: eventId,
        p_type: type,
        p_stale_after: STALE_AFTER,
      });
      if (error) {
        // A transient RPC failure must not silently drop a Stripe event —
        // proceed and run the handler (it's an idempotent state mirror,
        // see upsertFromSubscription). token=null: there is no real claim
        // to record, so markSucceeded/markFailed will no-op rather than
        // write a claim_token that was never actually established in the
        // DB.
        const code = (error as { code?: string }).code;
        if (isMissingOrForbiddenRpc(code)) {
          console.error("[billing/webhook] CLAIM_RPC_MISSING_OR_FORBIDDEN — claim_stripe_event is not callable (migration not applied, or grants misconfigured); dedupe is OFF for this event:", eventId, code, error.message);
        } else {
          console.error("[billing/webhook] CLAIM_RPC_FAILED — proceeding without a dedupe claim:", eventId, error.message);
        }
        return { status: "claimed", token: null };
      }

      const row = (Array.isArray(data) ? data[0] : data) as
        { claimed?: boolean; prior_status?: string | null; claim_token?: string | null } | null;
      if (!row || typeof row.claimed !== "boolean") {
        console.error("[billing/webhook] CLAIM_RPC_MALFORMED_RESPONSE — proceeding without a dedupe claim:", eventId, JSON.stringify(data));
        return { status: "claimed", token: null };
      }

      if (row.claimed) return { status: "claimed", token: row.claim_token ?? null };

      // claimed=false: a true duplicate (already 'succeeded') is safe to
      // ack; anything else (in particular 'pending', the still-fresh
      // concurrent-claim case) must NOT be reported as a plain duplicate
      // — that collapse is exactly what let BUG-25 F3 survive round 1.
      return row.prior_status === "succeeded" ? { status: "duplicate" } : { status: "in-flight" };
    },

    async markSucceeded(eventId, token) {
      if (token === null) return; // fail-open path never held a real claim
      const { data, error } = await admin
        .from(_STRIPE_EVENTS)
        .update({ status: "succeeded" })
        .eq("event_id", eventId)
        .eq("claim_token", token)
        .select("event_id");
      if (error) {
        console.error("[billing/webhook] MARK_SUCCEEDED_FAILED — status left pending, self-heals via the staleness window:", eventId, error.message);
        return;
      }
      if (!data || data.length === 0) {
        console.error("[billing/webhook] MARK_SUCCEEDED_NO_MATCHING_ROW — claim_token no longer matched (row reclaimed by a newer delivery, or vanished); this successful run was NOT recorded:", eventId);
      }
    },

    async markFailed(eventId, token) {
      if (token === null) return; // fail-open path never held a real claim
      // One retry, same shape as the pre-C6b release() mitigation: this
      // commonly fails in the SAME outage that just failed the handler.
      // Giving up after the retry is not a permanent loss —
      // claim_stripe_event's staleness window reclaims a stuck 'pending'
      // row on its own, so this is purely a latency optimisation for the
      // common case, not the fix itself.
      for (let attempt = 1; attempt <= 2; attempt++) {
        const { data, error } = await admin
          .from(_STRIPE_EVENTS)
          .update({ status: "failed" })
          .eq("event_id", eventId)
          .eq("claim_token", token)
          .select("event_id");
        if (!error) {
          if (!data || data.length === 0) {
            console.error("[billing/webhook] MARK_FAILED_NO_MATCHING_ROW — claim_token no longer matched (row reclaimed by a newer delivery, or vanished); this failure was NOT recorded:", eventId);
          }
          return;
        }
        if (attempt === 1) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        } else {
          console.error("[billing/webhook] MARK_FAILED_GIVEUP — status left pending, will self-heal via the staleness window:", eventId, error.message);
        }
      }
    },
  };
}
