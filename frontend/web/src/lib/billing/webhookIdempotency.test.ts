/**
 * Regression test for BUG #36 (pre-launch audit): the Stripe webhook's
 * dedupe row was written before the handler ran and never released on
 * failure, so a transient handler error permanently swallowed every retry
 * as a duplicate. Tested against an in-memory fake IdempotencyStore rather
 * than mocking Supabase, matching this repo's convention of testing the
 * pure logic out of an I/O orchestrator (see confirm.test.ts).
 */
import { describe, it, expect, vi } from "vitest";
import { runIdempotent, type IdempotencyStore } from "./webhookIdempotency";

function fakeStore(): IdempotencyStore & { claimed: Set<string> } {
  const claimed = new Set<string>();
  return {
    claimed,
    async claim(eventId) {
      if (claimed.has(eventId)) return { duplicate: true };
      claimed.add(eventId);
      return { duplicate: false };
    },
    async release(eventId) {
      claimed.delete(eventId);
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

    // Stripe's retry — same event id, second delivery attempt.
    const retry = await runIdempotent(store, "evt_1", "invoice.payment_failed", handler);
    expect(retry).toEqual({ status: "handled", result: "ok" });
    expect(handler).toHaveBeenCalledTimes(2);
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
});
