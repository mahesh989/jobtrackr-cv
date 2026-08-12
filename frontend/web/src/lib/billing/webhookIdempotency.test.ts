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

  it("KNOWN RESIDUAL (independent review, F2): if release() itself fails, the claim is NOT cleared and the next retry is wrongly treated as a duplicate — pinning the accepted behaviour, not asserting it's fine", async () => {
    const claimed = new Set<string>();
    const store: IdempotencyStore = {
      async claim(eventId) {
        if (claimed.has(eventId)) return { duplicate: true };
        claimed.add(eventId);
        return { duplicate: false };
      },
      async release() {
        // Simulates the same outage that failed the handler also failing
        // the release — the row is never actually cleared.
      },
    };
    const handler = vi.fn().mockRejectedValue(new Error("still down"));

    const first = await runIdempotent(store, "evt_3", "invoice.paid", handler);
    expect(first.status).toBe("failed");

    // The claim was never released, so this "retry" is misread as a
    // genuine duplicate and the handler does not run again. This is the
    // named residual case — production mitigates it with a delete retry
    // in the real store (route.ts), which this fake does not model.
    const retry = await runIdempotent(store, "evt_3", "invoice.paid", handler);
    expect(retry.status).toBe("duplicate");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a release() that THROWS does not mask the original handler error (independent review, F6)", async () => {
    const store: IdempotencyStore = {
      async claim() { return { duplicate: false }; },
      async release() { throw new Error("release blew up"); },
    };
    const originalError = new Error("original handler failure");
    const handler = vi.fn().mockRejectedValue(originalError);

    const result = await runIdempotent(store, "evt_4", "invoice.paid", handler);
    expect(result).toEqual({ status: "failed", error: originalError });
  });
});
