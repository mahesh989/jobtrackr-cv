/**
 * Regression tests for #50 (audit): `adminGrantUnlimitedAccess` explicitly
 * nulled `stripe_customer_id`/`stripe_subscription_id` on every call — for a
 * user who already had a live Stripe subscription, this severed their
 * billing linkage while Stripe kept charging their card: `/billing` showed
 * no card/invoices/cancel control (`details.ts`'s
 * `if (!row?.stripe_customer_id) return EMPTY`) and the portal route 422'd
 * with "No billing account yet". It also used `plan_id: 'unlimited'` +
 * `status: 'active'` — a REAL paid catalog plan/status — instead of this
 * schema's own `'comp'` status, built for exactly this "grandfathered, no
 * Stripe sub" case (see `entitlements.ts`).
 *
 * The fake admin client below models real Postgres `ON CONFLICT DO UPDATE
 * SET <only submitted columns>` upsert semantics: a column not present in
 * the payload keeps its EXISTING value on update (or NULL/default on a
 * genuinely new row) — this is the exact behavior the fix relies on to
 * preserve an existing Stripe linkage without ever setting it explicitly.
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
  const admin = {
    from(table: string) {
      if (table !== "subscriptions") throw new Error(`unexpected table: ${table}`);
      return {
        async upsert(payload: Row) {
          stored = stored ? { ...stored, ...payload } : { ...payload };
          return { error: null };
        },
      };
    },
  };
  return { admin, getStored: () => stored };
}

describe("adminGrantUnlimitedAccess", () => {
  beforeEach(() => {
    requireAdminMock.mockReset();
  });

  it("REGRESSION (#50): preserves an existing live Stripe linkage instead of nulling it", async () => {
    const { admin, getStored } = fakeAdminWithRow({
      user_id: "user_1",
      stripe_customer_id: "cus_real123",
      stripe_subscription_id: "sub_real456",
      plan_id: "monthly",
      status: "active",
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
      status: "active",
    });
    requireAdminMock.mockResolvedValue({ admin });

    await adminGrantUnlimitedAccess("user_1");

    const row = getStored();
    expect(row?.plan_id).toBe("comp");
    expect(row?.status).toBe("comp");
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

  it("fixes an existing expired-comp or trialing row (the button's own stated use case) without touching its stale Stripe fields destructively", async () => {
    const { admin, getStored } = fakeAdminWithRow({
      user_id: "user_1",
      stripe_customer_id: "cus_trial",
      stripe_subscription_id: "sub_trial",
      plan_id: "trial",
      status: "trialing",
    });
    requireAdminMock.mockResolvedValue({ admin });

    await adminGrantUnlimitedAccess("user_1");

    const row = getStored();
    expect(row).toMatchObject({ plan_id: "comp", status: "comp" });
    // Linkage preserved, not destroyed — same guarantee as the first test,
    // pinned again here because this is the exact scenario the UI's own
    // comment ("fixes expired comp, trialing, or wrong-plan subs") targets.
    expect(row?.stripe_customer_id).toBe("cus_trial");
  });
});
