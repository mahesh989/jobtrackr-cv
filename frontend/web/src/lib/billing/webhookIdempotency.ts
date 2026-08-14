/**
 * Idempotent-claim wrapper for the Stripe webhook handler (BUG #36, then
 * durably fixed for BUG-25 F3/F4 — execution chunk C6b, 2 review rounds).
 *
 * The dedupe decision must survive a handler failure without either (a)
 * permanently swallowing every retry as a duplicate (BUG #36 — fixed by
 * releasing the claim on failure), or (b) losing forensic trace of what
 * happened / racing a genuinely-concurrent duplicate delivery (BUG-25 F3/
 * F4 — the release()-based design's own residuals).
 *
 * Round 1 moved to a durable status column + a row-locked atomic claim
 * decision in Postgres (migrations/011_stripe_events_claim_status.sql,
 * stripeEventStore.ts) but an independent review found round 1's APP CODE
 * still collapsed "already succeeded" and "still genuinely in-flight"
 * into the same claim()-returns-duplicate branch, which meant F3's false
 * 200-ack was still reachable end to end even though the DB layer could
 * now distinguish the two. Round 2 (this file): claim() is a three-way
 * result — "duplicate" (true duplicate, safe to ack) is now distinct from
 * "in-flight" (a concurrent claim that might still fail, must NOT be
 * acked as done) — and markSucceeded/markFailed require the claim's own
 * token, so a caller whose claim has since gone stale and been reclaimed
 * by someone else can't stamp status over the newer claim's row (F4,
 * closed for the mark calls too, not just claim()).
 *
 * This module stays store-agnostic and I/O-free so the claim/handle/
 * record ordering is unit-testable without mocking Supabase.
 */

export type ClaimResult =
  | { status: "claimed"; token: string | null }
  | { status: "duplicate" }
  | { status: "in-flight" };

export interface IdempotencyStore {
  /** Atomically decide whether this delivery should run the handler. See
   *  ClaimResult. token is null only when the store itself failed open
   *  (couldn't determine claim state) — markSucceeded/markFailed treat a
   *  null token as "there was never a real claim to record" and no-op. */
  claim(eventId: string, type: string): Promise<ClaimResult>;
  /** Record a successful run. The row is never deleted — durable trace.
   *  Guarded by the SAME token claim() returned, so a stale claimant
   *  can't overwrite a newer claim's status. */
  markSucceeded(eventId: string, token: string | null): Promise<void>;
  /** Record a failed run so a later delivery (Stripe retry, or a still-
   *  fresh concurrent duplicate past its own staleness window) can
   *  reclaim and retry. Same token-guard as markSucceeded. */
  markFailed(eventId: string, token: string | null): Promise<void>;
}

export type IdempotentResult<T> =
  | { status: "duplicate" }
  | { status: "in-flight" }
  | { status: "handled"; result: T }
  | { status: "failed"; error: unknown };

export async function runIdempotent<T>(
  store: IdempotencyStore,
  eventId: string,
  type: string,
  handler: () => Promise<T>,
): Promise<IdempotentResult<T>> {
  const claim = await store.claim(eventId, type);
  if (claim.status === "duplicate") return { status: "duplicate" };
  if (claim.status === "in-flight") return { status: "in-flight" };

  let result: T;
  try {
    result = await handler();
  } catch (error) {
    // markFailed BEFORE returning — a Stripe retry must be able to
    // reclaim this event. Guarded in its own try/catch: a markFailed()
    // that throws must not mask the original handler error (independent
    // review of the original C6 chunk, F6 — same reasoning still applies
    // to the renamed method).
    try {
      await store.markFailed(eventId, claim.token);
    } catch (markError) {
      console.error("[webhookIdempotency] markFailed() itself threw — original error takes precedence:", markError);
    }
    return { status: "failed", error };
  }

  // markSucceeded is guarded the same way markFailed is above — a store
  // whose markSucceeded() throws must not misreport an actually-successful
  // handler run as failed by falling into a catch block that assumes the
  // handler itself broke.
  try {
    await store.markSucceeded(eventId, claim.token);
  } catch (markError) {
    console.error("[webhookIdempotency] markSucceeded() itself threw — the handler DID succeed:", markError);
  }
  return { status: "handled", result };
}

/**
 * Pure outcome -> HTTP response mapping, extracted out of route.ts so the
 * F3 fix (in-flight must NOT get a 2xx) is unit-testable without a Next.js
 * request/response runtime (independent review, round 2 — this exact
 * mapping is where F3 actually lives, and round 1 had zero test coverage
 * on it).
 */
export function outcomeToHttpResponse(
  outcome: IdempotentResult<unknown>,
): { status: number; body: Record<string, unknown> } {
  switch (outcome.status) {
    case "duplicate":
      return { status: 200, body: { received: true, duplicate: true } };
    case "in-flight":
      // Non-2xx so Stripe retries — a genuinely concurrent delivery whose
      // original claim might still fail must never be permanently
      // acknowledged as done (BUG-25 F3).
      return { status: 409, body: { received: false, retry: true } };
    case "handled":
      return { status: 200, body: { received: true } };
    case "failed":
      return { status: 500, body: { received: false } };
  }
}
