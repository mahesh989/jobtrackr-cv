/**
 * Regression tests for runIdempotent and outcomeToHttpResponse (BUG #36,
 * then BUG-25 F3/F4 — the durable status-based redesign, execution chunk
 * C6b, 2 review rounds). Tested against an in-memory fake IdempotencyStore
 * rather than mocking Supabase, matching this repo's convention of
 * testing the pure logic out of an I/O orchestrator (see confirm.test.ts).
 * The real Supabase-backed store's own claim/mark logic — and the
 * row-locked staleness/reclaim semantics that live in
 * claim_stripe_event() — are tested separately in stripeEventStore.test.ts;
 * nothing here can exercise Postgres row locking, that's inherently
 * server-side.
 *
 * Round 2 note (independent review): round 1's "concurrent duplicate"
 * test here asserted a property of the FAKE store, not of runIdempotent —
 * the fake hardcoded pending -> "duplicate", so the test could not fail
 * for any implementation of runIdempotent. Fixed by giving the fake a
 * genuine three-way claim() (matching the real store's ClaimResult
 * shape) so "duplicate" (succeeded) and "in-flight" (still-pending) are
 * actually different code paths runIdempotent must route correctly, and
 * by testing outcomeToHttpResponse directly — that mapping is where F3
 * actually lives (the HTTP status Stripe receives), and round 1 had zero
 * coverage on it.
 */
import { describe, it, expect, vi } from "vitest";
import { runIdempotent, outcomeToHttpResponse, type IdempotencyStore, type ClaimResult } from "./webhookIdempotency";

function fakeStore(): IdempotencyStore & { statusByEvent: Map<string, "pending" | "succeeded" | "failed">; tokenByEvent: Map<string, string> } {
  const statusByEvent = new Map<string, "pending" | "succeeded" | "failed">();
  const tokenByEvent = new Map<string, string>();
  let nextToken = 0;
  return {
    statusByEvent,
    tokenByEvent,
    async claim(eventId): Promise<ClaimResult> {
      const existing = statusByEvent.get(eventId);
      if (existing === "succeeded") return { status: "duplicate" };
      if (existing === "pending") return { status: "in-flight" };
      // Fresh claim, or reclaiming a "failed" row — mint a new token,
      // same shape as a real reclaim invalidating the previous one.
      const token = `token-${nextToken++}`;
      statusByEvent.set(eventId, "pending");
      tokenByEvent.set(eventId, token);
      return { status: "claimed", token };
    },
    async markSucceeded(eventId, token) {
      if (token !== null && tokenByEvent.get(eventId) === token) statusByEvent.set(eventId, "succeeded");
    },
    async markFailed(eventId, token) {
      if (token !== null && tokenByEvent.get(eventId) === token) statusByEvent.set(eventId, "failed");
    },
  };
}

describe("runIdempotent", () => {
  it("REGRESSION (#36): a Stripe retry after a transient handler failure re-runs the handler, not swallowed as a duplicate", async () => {
    const store = fakeStore();
    const handler = vi.fn()
      .mockRejectedValueOnce(new Error("Stripe 5xx on subscriptions.retrieve"))
      .mockResolvedValueOnce("ok");

    const first = await runIdempotent(store, "evt_1", "invoice.payment_failed", handler);
    expect(first.status).toBe("failed");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(store.statusByEvent.get("evt_1")).toBe("failed");

    // Stripe's retry — same event id, second delivery attempt.
    const retry = await runIdempotent(store, "evt_1", "invoice.payment_failed", handler);
    expect(retry).toEqual({ status: "handled", result: "ok" });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(store.statusByEvent.get("evt_1")).toBe("succeeded");
  });

  it("a genuine duplicate delivery after a SUCCESSFUL handler run is still a no-op", async () => {
    const store = fakeStore();
    const handler = vi.fn().mockResolvedValue("ok");

    const first = await runIdempotent(store, "evt_2", "checkout.session.completed", handler);
    expect(first).toEqual({ status: "handled", result: "ok" });

    const replay = await runIdempotent(store, "evt_2", "checkout.session.completed", handler);
    expect(replay.status).toBe("duplicate");
    expect(handler).toHaveBeenCalledTimes(1); // NOT called again
  });

  it("two different event ids are independent", async () => {
    const store = fakeStore();
    const handler = vi.fn().mockResolvedValue("ok");

    await runIdempotent(store, "evt_a", "invoice.paid", handler);
    const b = await runIdempotent(store, "evt_b", "invoice.paid", handler);

    expect(b.status).toBe("handled");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("REGRESSION (BUG-25 F3, round 2): a still-in-flight concurrent duplicate is reported as 'in-flight', DISTINCT from a true 'duplicate' — not collapsed into the same branch", async () => {
    // The fake's claim() genuinely branches on status the same way the
    // real RPC does (see fakeStore above) — this is not begging the
    // question the way round 1's version did, because "succeeded" and
    // "pending" are reachable via two different prior calls to claim(),
    // not a single hardcoded fake response.
    const store = fakeStore();
    const handler = vi.fn().mockResolvedValue("ok");

    // First delivery claims and is (for the purposes of this test) still
    // mid-handler — never resolves markSucceeded/markFailed before the
    // second delivery arrives.
    const firstClaim = await store.claim("evt_concurrent", "invoice.paid");
    expect(firstClaim.status).toBe("claimed");

    const second = await runIdempotent(store, "evt_concurrent", "invoice.paid", handler);
    expect(second.status).toBe("in-flight"); // NOT "duplicate"
    expect(handler).not.toHaveBeenCalled();
  });

  it("a markFailed() that THROWS does not mask the original handler error (independent review of the original C6 chunk, F6 — same guard, renamed method)", async () => {
    const store: IdempotencyStore = {
      async claim() { return { status: "claimed", token: "t1" }; },
      async markSucceeded() {},
      async markFailed() { throw new Error("markFailed blew up"); },
    };
    const originalError = new Error("original handler failure");
    const handler = vi.fn().mockRejectedValue(originalError);

    const result = await runIdempotent(store, "evt_4", "invoice.paid", handler);
    expect(result).toEqual({ status: "failed", error: originalError });
  });

  it("a markSucceeded() that THROWS does not misreport an actually-successful handler run as failed", async () => {
    // Symmetric bug to F6: markSucceeded() runs inside the same scope as
    // the handler call. Without its own try/catch, a throw here would
    // fall into the SAME catch block used for handler failures, wrongly
    // calling markFailed() and returning {status: "failed"} for a
    // handler that actually completed successfully.
    const store: IdempotencyStore = {
      async claim() { return { status: "claimed", token: "t1" }; },
      async markSucceeded() { throw new Error("markSucceeded blew up"); },
      async markFailed() { throw new Error("should never be called — the handler succeeded"); },
    };
    const handler = vi.fn().mockResolvedValue("ok");

    const result = await runIdempotent(store, "evt_5", "invoice.paid", handler);
    expect(result).toEqual({ status: "handled", result: "ok" });
  });

  it("passes claim()'s null token through to markSucceeded/markFailed unchanged (the fail-open path never held a real claim)", async () => {
    const markSucceeded = vi.fn();
    const markFailed = vi.fn();
    const store: IdempotencyStore = {
      async claim() { return { status: "claimed", token: null }; },
      markSucceeded,
      markFailed,
    };

    await runIdempotent(store, "evt_6", "invoice.paid", async () => "ok");
    expect(markSucceeded).toHaveBeenCalledWith("evt_6", null);

    await runIdempotent(store, "evt_7", "invoice.paid", async () => { throw new Error("boom"); });
    expect(markFailed).toHaveBeenCalledWith("evt_7", null);
  });
});

describe("outcomeToHttpResponse", () => {
  it("REGRESSION (BUG-25 F3): 'in-flight' gets a non-2xx, so Stripe keeps retrying instead of receiving a false all-clear", () => {
    const { status } = outcomeToHttpResponse({ status: "in-flight" });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500); // 409-shaped: a decision, not a server error — distinct from "handler failed"
  });

  it("a true duplicate (already succeeded) gets a 2xx", () => {
    const { status, body } = outcomeToHttpResponse({ status: "duplicate" });
    expect(status).toBeGreaterThanOrEqual(200);
    expect(status).toBeLessThan(300);
    expect(body.duplicate).toBe(true);
  });

  it("a handled run gets a 2xx", () => {
    const { status } = outcomeToHttpResponse({ status: "handled", result: undefined });
    expect(status).toBeGreaterThanOrEqual(200);
    expect(status).toBeLessThan(300);
  });

  it("a failed run gets a 5xx, distinct from 'in-flight's 4xx", () => {
    const { status } = outcomeToHttpResponse({ status: "failed", error: new Error("boom") });
    expect(status).toBeGreaterThanOrEqual(500);
  });
});
