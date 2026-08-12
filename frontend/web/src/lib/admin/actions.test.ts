/**
 * Regression tests for #50 (audit) + its independent review:
 *
 * `adminGrantUnlimitedAccess` explicitly nulled `stripe_customer_id`/
 * `stripe_subscription_id` on every call — for a user who already had a
 * live Stripe subscription, this severed their billing linkage while
 * Stripe kept charging their card: `/billing` showed no card/invoices/
 * cancel control (`details.ts`'s `if (!row?.stripe_customer_id) return
 * EMPTY`) and the portal route 422'd with "No billing account yet". It
 * also used `plan_id: 'unlimited'` + `status: 'active'` — a REAL paid
 * catalog plan/status — instead of this schema's own `'comp'` status,
 * built for exactly this "grandfathered, no Stripe sub" case (see
 * `entitlements.ts`).
 *
 * The first fix pass (preserve linkage, use comp/comp) was itself
 * independently reviewed and found to open a NEW hole: switching status to
 * 'comp' while preserving a live stripe_subscription_id removes the only
 * signal checkoutDecision.ts's double-billing guard has ('comp' is not in
 * LIVE_STATES) — the user could reach /pricing and start a second,
 * concurrently-charging subscription. Fixed by refusing the grant entirely
 * when the target already has a LIVE Stripe-driven subscription
 * (active/trialing/past_due with a real stripe_subscription_id).
 *
 * The fake admin client below models real Postgres `ON CONFLICT DO UPDATE
 * SET <only submitted columns>` upsert semantics (verified independently
 * against @supabase/postgrest-js's source, not just this comment): a column
 * not present in the payload keeps its EXISTING value on update (or
 * NULL/default on a genuinely new row).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAdminMock = vi.fn();
vi.mock("@/lib/admin/guard", () => ({
  requireAdmin: () => requireAdminMock(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { adminGrantUnlimitedAccess } from "./actions";

type Row = Record<string, unknown>;

function fakeAdminWithRow(initialRow: Row | null) {
  let stored: Row | null = initialRow;
  let upsertCalls = 0;
  const admin = {
    from(table: string) {
      if (table !== "subscriptions") throw new Error(`unexpected table: ${table}`);
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  return { data: stored, error: null };
                },
              };
            },
          };
        },
        async upsert(payload: Row) {
          upsertCalls++;
          stored = stored ? { ...stored, ...payload } : { ...payload };
          return { error: null };
        },
      };
    },
  };
  return { admin, getStored: () => stored, getUpsertCalls: () => upsertCalls };
}

describe("adminGrantUnlimitedAccess", () => {
  beforeEach(() => {
    requireAdminMock.mockReset();
  });

  describe("REGRESSION (#50): refuses to grant on top of a LIVE Stripe subscription", () => {
    it.each(["active", "trialing", "past_due"])(
      "throws and does not touch the row when status is '%s' with a real stripe_subscription_id",
      async (status) => {
        const { admin, getStored, getUpsertCalls } = fakeAdminWithRow({
          user_id: "user_1",
          stripe_customer_id: "cus_real123",
          stripe_subscription_id: "sub_real456",
          plan_id: "monthly",
          status,
        });
        requireAdminMock.mockResolvedValue({ admin });

        await expect(adminGrantUnlimitedAccess("user_1")).rejects.toThrow(/live Stripe subscription/);

        // Refused BEFORE any write — the row is untouched.
        expect(getUpsertCalls()).toBe(0);
        expect(getStored()).toMatchObject({ status, stripe_subscription_id: "sub_real456" });
      },
    );

    it("proceeds when status is live but there is no real stripe_subscription_id (nothing to protect)", async () => {
      const { admin, getStored } = fakeAdminWithRow({
        user_id: "user_1",
        stripe_customer_id: null,
        stripe_subscription_id: null,
        plan_id: "unlimited",
        status: "active", // e.g. a row corrupted by the OLD #50 bug itself
      });
      requireAdminMock.mockResolvedValue({ admin });

      await expect(adminGrantUnlimitedAccess("user_1")).resolves.toBeUndefined();
      expect(getStored()).toMatchObject({ plan_id: "comp", status: "comp" });
    });
  });

  it("REGRESSION (#50): preserves an existing (non-live) Stripe linkage instead of nulling it", async () => {
    const { admin, getStored } = fakeAdminWithRow({
      user_id: "user_1",
      stripe_customer_id: "cus_real123",
      stripe_subscription_id: "sub_real456",
      plan_id: "monthly",
      status: "canceled",
    });
    requireAdminMock.mockResolvedValue({ admin });

    await adminGrantUnlimitedAccess("user_1");

    const row = getStored();
    expect(row?.stripe_customer_id).toBe("cus_real123");
    expect(row?.stripe_subscription_id).toBe("sub_real456");
  });

  it("REGRESSION (#50): grants status='comp' + plan_id='comp', not the real paid 'unlimited'/'active'", async () => {
    const { admin, getStored } = fakeAdminWithRow({
      user_id: "user_1",
      stripe_customer_id: "cus_real123",
      stripe_subscription_id: "sub_real456",
      plan_id: "monthly",
      status: "canceled",
    });
    requireAdminMock.mockResolvedValue({ admin });

    await adminGrantUnlimitedAccess("user_1");

    const row = getStored();
    expect(row?.plan_id).toBe("comp");
    expect(row?.status).toBe("comp");
  });

  it("resets cancel_at_period_end to false — a granted comp row should never show a stale 'cancelling' banner", async () => {
    const { admin, getStored } = fakeAdminWithRow({
      user_id: "user_1",
      stripe_customer_id: "cus_real123",
      stripe_subscription_id: "sub_real456",
      plan_id: "monthly",
      status: "canceled",
      cancel_at_period_end: true,
    });
    requireAdminMock.mockResolvedValue({ admin });

    await adminGrantUnlimitedAccess("user_1");

    expect(getStored()?.cancel_at_period_end).toBe(false);
  });

  it("a brand-new user with no existing row gets a clean comp grant, no Stripe fields set", async () => {
    const { admin, getStored } = fakeAdminWithRow(null);
    requireAdminMock.mockResolvedValue({ admin });

    await adminGrantUnlimitedAccess("user_new");

    const row = getStored();
    expect(row).toMatchObject({ user_id: "user_new", plan_id: "comp", status: "comp", trial_end: null });
    expect(row?.stripe_customer_id).toBeUndefined();
    expect(row?.stripe_subscription_id).toBeUndefined();
  });

  it("sets a ~10-year period from now", async () => {
    const { admin, getStored } = fakeAdminWithRow(null);
    requireAdminMock.mockResolvedValue({ admin });

    const before = Date.now();
    await adminGrantUnlimitedAccess("user_new");
    const after = Date.now();

    const row = getStored();
    const start = new Date(row?.current_period_start as string).getTime();
    const end = new Date(row?.current_period_end as string).getTime();
    expect(start).toBeGreaterThanOrEqual(before);
    expect(start).toBeLessThanOrEqual(after);
    const tenYearsMs = 10 * 365 * 24 * 60 * 60 * 1000;
    expect(end - start).toBeGreaterThan(tenYearsMs - 5000);
    expect(end - start).toBeLessThan(tenYearsMs + 5000);
  });

  it("fixes an existing expired-comp or wrong-plan (non-live) row without touching its stale Stripe fields destructively", async () => {
    const { admin, getStored } = fakeAdminWithRow({
      user_id: "user_1",
      stripe_customer_id: "cus_old",
      stripe_subscription_id: "sub_old",
      plan_id: "weekly",
      status: "incomplete_expired",
    });
    requireAdminMock.mockResolvedValue({ admin });

    await adminGrantUnlimitedAccess("user_1");

    const row = getStored();
    expect(row).toMatchObject({ plan_id: "comp", status: "comp" });
    expect(row?.stripe_customer_id).toBe("cus_old");
  });
});
