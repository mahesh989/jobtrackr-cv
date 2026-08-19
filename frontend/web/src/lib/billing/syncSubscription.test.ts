/**
 * Regression tests for BUG-26 (found reviewing #37): resolveUserId's DB
 * lookup discarded its error, and upsertFromSubscription logged-and-returned
 * instead of throwing when no fallback resolved a user_id — so a webhook
 * event whose subscription belonged to nobody findable completed
 * "successfully" from runIdempotent's point of view (see webhookIdempotency.ts
 * / BUG #36), Stripe stopped retrying, and the sync was silently dropped
 * with no trace. Fixed to log the lookup error and to throw on an
 * unresolvable user_id, matching the fail-loud convention this file already
 * uses for its own upsert write (the "MUST check error and throw" comment).
 */
import { describe, it, expect, vi } from "vitest";
import type Stripe from "stripe";
import { resolveUserId, upsertFromSubscription } from "./syncSubscription";
import type { createAdminClient } from "@/lib/supabase/admin";

type AdminOpts = {
  selectRow?: { user_id?: string } | null;
  selectError?: { message: string } | null;
  upsertError?: { message: string } | null;
};

function fakeAdmin(opts: AdminOpts = {}): ReturnType<typeof createAdminClient> {
  const { selectRow = null, selectError = null, upsertError = null } = opts;
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  return { data: selectRow, error: selectError };
                },
              };
            },
          };
        },
        async upsert() {
          return { error: upsertError };
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function fakeStripe(customerUserId: string | null = null, deleted = false): Stripe {
  return {
    customers: {
      async retrieve() {
        return deleted
          ? { deleted: true }
          : { deleted: false, metadata: { user_id: customerUserId ?? undefined } };
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function fakeSub(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: "sub_123",
    customer: "cus_123",
    status: "active",
    metadata: {},
    items: { data: [{ price: { id: "price_1" } }] },
    trial_end: null,
    cancel_at_period_end: false,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("resolveUserId", () => {
  it("returns the fast-path user_id from subscription metadata without touching the DB or Stripe", async () => {
    const sub = fakeSub({ metadata: { user_id: "user_from_sub" } });
    const admin = fakeAdmin({ selectError: { message: "should never be reached" } });
    const stripe = fakeStripe("should_not_be_used");

    await expect(resolveUserId(stripe, sub, admin)).resolves.toBe("user_from_sub");
  });

  it("returns the DB row's user_id when the lookup succeeds", async () => {
    const sub = fakeSub();
    const admin = fakeAdmin({ selectRow: { user_id: "user_from_db" } });
    const stripe = fakeStripe();

    await expect(resolveUserId(stripe, sub, admin)).resolves.toBe("user_from_db");
  });

  it("REGRESSION (BUG-26): logs a DB lookup error instead of silently swallowing it, and still falls through to the Stripe metadata fallback", async () => {
    const sub = fakeSub();
    const admin = fakeAdmin({ selectError: { message: "PostgREST 503" } });
    const stripe = fakeStripe("user_from_stripe");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await resolveUserId(stripe, sub, admin);

    expect(result).toBe("user_from_stripe");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("resolveUserId DB lookup failed"),
      "PostgREST 503",
    );
    errSpy.mockRestore();
  });

  it("falls back to Stripe customer metadata when the DB lookup returns no row (no error)", async () => {
    const sub = fakeSub();
    const admin = fakeAdmin({ selectRow: null });
    const stripe = fakeStripe("user_from_stripe");

    await expect(resolveUserId(stripe, sub, admin)).resolves.toBe("user_from_stripe");
  });

  it("returns null when every fallback path is exhausted", async () => {
    const sub = fakeSub();
    const admin = fakeAdmin({ selectRow: null });
    const stripe = fakeStripe(null);

    await expect(resolveUserId(stripe, sub, admin)).resolves.toBeNull();
  });
});

describe("upsertFromSubscription", () => {
  it("REGRESSION (BUG-26): throws — does not log-and-return — when no fallback resolves a user_id, so the caller (and the webhook's runIdempotent) sees a real failure instead of a silent success", async () => {
    const sub = fakeSub();
    const admin = fakeAdmin({ selectRow: null });
    const stripe = fakeStripe(null);

    await expect(upsertFromSubscription(stripe, sub, admin)).rejects.toThrow(
      "could not resolve user_id for sub sub_123",
    );
  });

  it("still throws on a failed upsert write, unaffected by this fix (pre-existing behaviour)", async () => {
    const sub = fakeSub();
    const admin = fakeAdmin({
      selectRow: { user_id: "user_1" },
      upsertError: { message: "constraint violation" },
    });
    const stripe = fakeStripe();

    await expect(upsertFromSubscription(stripe, sub, admin)).rejects.toThrow(
      "subscriptions upsert failed: constraint violation",
    );
  });

  it("resolves cleanly on the happy path", async () => {
    const sub = fakeSub();
    const admin = fakeAdmin({ selectRow: { user_id: "user_1" } });
    const stripe = fakeStripe();

    await expect(upsertFromSubscription(stripe, sub, admin)).resolves.toBeUndefined();
  });
});
