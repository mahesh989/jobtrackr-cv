/**
 * Regression tests for the real Supabase-backed IdempotencyStore (BUG-25
 * F3/F4, execution chunk C6b, 2 review rounds). The row-locked staleness/
 * reclaim decision itself lives in claim_stripe_event() (Postgres,
 * migrations/011_...sql) and cannot be exercised from a JS unit test —
 * these tests pin how stripeEventStore.ts maps that RPC's result
 * (including the round-2 fix: prior_status now distinguishes "duplicate"
 * from "in-flight" instead of collapsing both), and its own error
 * handling (fail-open + classified logging on claim() RPC failure,
 * ownership-token-guarded + retry-then-give-up on the mark calls).
 */
import { describe, it, expect, vi } from "vitest";
import { createStripeEventStore } from "./stripeEventStore";

function fakeAdmin(opts: {
  rpcResult?: { data: unknown; error: { message: string; code?: string } | null };
  updateResult?: { data: unknown; error: { message: string } | null };
}) {
  const rpc = vi.fn().mockResolvedValue(
    opts.rpcResult ?? { data: [{ claimed: true, prior_status: null, claim_token: "tok-1" }], error: null },
  );
  const select = vi.fn().mockResolvedValue(
    opts.updateResult ?? { data: [{ event_id: "evt" }], error: null },
  );
  const eq2 = vi.fn().mockReturnValue({ select });
  const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
  const update = vi.fn().mockReturnValue({ eq: eq1 });
  const from = vi.fn().mockReturnValue({ update });
  return { rpc, from, update, eq1, eq2, select } as unknown as Parameters<typeof createStripeEventStore>[0] & {
    rpc: typeof rpc; from: typeof from; update: typeof update; eq1: typeof eq1; eq2: typeof eq2; select: typeof select;
  };
}

describe("createStripeEventStore", () => {
  describe("claim", () => {
    it("returns {status:'claimed', token} when claim_stripe_event reports claimed=true", async () => {
      const admin = fakeAdmin({ rpcResult: { data: [{ claimed: true, prior_status: null, claim_token: "tok-abc" }], error: null } });
      const store = createStripeEventStore(admin);
      const result = await store.claim("evt_1", "invoice.paid");
      expect(result).toEqual({ status: "claimed", token: "tok-abc" });
      // REGRESSION (round-2 review, N2): exact object, not objectContaining —
      // objectContaining doesn't assert absent keys, so a regression that
      // silently dropped p_stale_after (reverting to the SQL function's
      // 5-minute default and reopening finding #2) would pass a looser
      // assertion. Mutation-verified: deleting p_stale_after from the RPC
      // call fails this exact assertion.
      expect(admin.rpc).toHaveBeenCalledWith("claim_stripe_event", {
        p_event_id: "evt_1",
        p_type: "invoice.paid",
        p_stale_after: "45 seconds",
      });
    });

    it("REGRESSION (BUG-25 F3, round 2): returns 'duplicate' (not 'in-flight') when prior_status is 'succeeded'", async () => {
      const admin = fakeAdmin({ rpcResult: { data: [{ claimed: false, prior_status: "succeeded", claim_token: null }], error: null } });
      const store = createStripeEventStore(admin);
      expect(await store.claim("evt_2", "invoice.paid")).toEqual({ status: "duplicate" });
    });

    it("REGRESSION (BUG-25 F3, round 2): returns 'in-flight' (NOT 'duplicate') when prior_status is 'pending' — round 1 collapsed this into the same false-200-ack branch as a true duplicate", async () => {
      const admin = fakeAdmin({ rpcResult: { data: [{ claimed: false, prior_status: "pending", claim_token: null }], error: null } });
      const store = createStripeEventStore(admin);
      expect(await store.claim("evt_3", "invoice.paid")).toEqual({ status: "in-flight" });
    });

    it("fails OPEN (status:'claimed', token:null) when the RPC itself errors, so a transient outage never silently drops a Stripe event", async () => {
      const admin = fakeAdmin({ rpcResult: { data: null, error: { message: "connection reset" } } });
      const store = createStripeEventStore(admin);
      expect(await store.claim("evt_4", "invoice.paid")).toEqual({ status: "claimed", token: null });
    });

    it("REGRESSION: fails OPEN (not silently 'duplicate') on a malformed/empty RPC response", async () => {
      const admin = fakeAdmin({ rpcResult: { data: [], error: null } });
      const store = createStripeEventStore(admin);
      expect(await store.claim("evt_5", "invoice.paid")).toEqual({ status: "claimed", token: null });
    });

    it("handles a bare-object RPC response (not wrapped in an array), matching how Postgres single-row RETURNS TABLE can come back", async () => {
      const admin = fakeAdmin({ rpcResult: { data: { claimed: true, prior_status: "failed", claim_token: "tok-z" } as unknown, error: null } });
      const store = createStripeEventStore(admin);
      expect(await store.claim("evt_6", "invoice.paid")).toEqual({ status: "claimed", token: "tok-z" });
    });
  });

  describe("markSucceeded", () => {
    it("updates status to succeeded, filtered by BOTH event_id and claim_token", async () => {
      const admin = fakeAdmin({});
      const store = createStripeEventStore(admin);
      await store.markSucceeded("evt_7", "tok-1");
      expect(admin.from).toHaveBeenCalledWith("stripe_events");
      expect(admin.update).toHaveBeenCalledWith({ status: "succeeded" });
      expect(admin.eq1).toHaveBeenCalledWith("event_id", "evt_7");
      expect(admin.eq2).toHaveBeenCalledWith("claim_token", "tok-1");
    });

    it("no-ops without touching the DB when token is null (fail-open path never held a real claim)", async () => {
      const admin = fakeAdmin({});
      const store = createStripeEventStore(admin);
      await store.markSucceeded("evt_8", null);
      expect(admin.from).not.toHaveBeenCalled();
    });

    it("does not throw when the update fails (best-effort, logs and moves on)", async () => {
      const admin = fakeAdmin({ updateResult: { data: null, error: { message: "boom" } } });
      const store = createStripeEventStore(admin);
      await expect(store.markSucceeded("evt_9", "tok-1")).resolves.toBeUndefined();
    });

    it("REGRESSION (BUG-25 F4, round 2): does not throw when the claim_token no longer matches (row reclaimed by a newer delivery) — zero rows affected, not an error", async () => {
      const admin = fakeAdmin({ updateResult: { data: [], error: null } });
      const store = createStripeEventStore(admin);
      await expect(store.markSucceeded("evt_10", "stale-tok")).resolves.toBeUndefined();
    });
  });

  describe("markFailed", () => {
    it("updates status to failed on the first attempt when it succeeds, filtered by claim_token", async () => {
      const admin = fakeAdmin({});
      const store = createStripeEventStore(admin);
      await store.markFailed("evt_11", "tok-1");
      expect(admin.update).toHaveBeenCalledTimes(1);
      expect(admin.update).toHaveBeenCalledWith({ status: "failed" });
      expect(admin.eq2).toHaveBeenCalledWith("claim_token", "tok-1");
    });

    it("no-ops without touching the DB when token is null", async () => {
      const admin = fakeAdmin({});
      const store = createStripeEventStore(admin);
      await store.markFailed("evt_12", null);
      expect(admin.from).not.toHaveBeenCalled();
    });

    it("REGRESSION: retries once before giving up, and never throws even when both attempts fail", async () => {
      const select = vi.fn()
        .mockResolvedValueOnce({ data: null, error: { message: "outage" } })
        .mockResolvedValueOnce({ data: null, error: { message: "still down" } });
      const eq2 = vi.fn().mockReturnValue({ select });
      const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
      const update = vi.fn().mockReturnValue({ eq: eq1 });
      const from = vi.fn().mockReturnValue({ update });
      const admin = { rpc: vi.fn(), from } as unknown as Parameters<typeof createStripeEventStore>[0];

      const store = createStripeEventStore(admin);
      await expect(store.markFailed("evt_13", "tok-1")).resolves.toBeUndefined();
      expect(select).toHaveBeenCalledTimes(2); // exactly one retry, not an infinite/unbounded loop
    });

    it("does not retry once an attempt succeeds", async () => {
      const select = vi.fn().mockResolvedValueOnce({ data: [{ event_id: "evt_14" }], error: null });
      const eq2 = vi.fn().mockReturnValue({ select });
      const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
      const update = vi.fn().mockReturnValue({ eq: eq1 });
      const from = vi.fn().mockReturnValue({ update });
      const admin = { rpc: vi.fn(), from } as unknown as Parameters<typeof createStripeEventStore>[0];

      const store = createStripeEventStore(admin);
      await store.markFailed("evt_14", "tok-1");
      expect(select).toHaveBeenCalledTimes(1);
    });
  });
});
