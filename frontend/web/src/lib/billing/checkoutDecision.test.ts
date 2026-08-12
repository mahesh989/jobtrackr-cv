/**
 * Regression test for BUG #37 (pre-launch audit): checkout's existing-
 * subscription query discarded its error, so a transient failure was
 * indistinguishable from "no subscription" — skipping the double-billing
 * guard and potentially re-granting a used trial.
 */
import { describe, it, expect } from "vitest";
import { decideCheckout } from "./checkoutDecision";

describe("decideCheckout", () => {
  it("REGRESSION (#37): a query error is NEVER treated as 'no subscription' — even for an active subscriber", () => {
    // The exact shape of the bug: an active subscriber's row, but the SELECT
    // that would have returned it failed transiently.
    const activeSubRow = { stripe_customer_id: "cus_real123", status: "active" as const };
    const queryError = { message: "PostgREST 503" };

    const decision = decideCheckout(activeSubRow, queryError, false);
    expect(decision).toEqual({ kind: "query_failed" });
  });

  it("REGRESSION (#37), trial angle: a query error must not look like trial-eligible for a user who already subscribed", () => {
    const previouslySubscribedRow = { stripe_customer_id: "cus_x", status: "canceled" as const };
    const queryError = { message: "connection reset" };

    const decision = decideCheckout(previouslySubscribedRow, queryError, true);
    // Must be query_failed, NOT { kind: "proceed", trialEligible: true }.
    expect(decision.kind).toBe("query_failed");
  });

  it("an active/trialing/past_due subscriber is blocked by the double-billing guard (no query error)", () => {
    for (const status of ["active", "trialing", "past_due"] as const) {
      const decision = decideCheckout({ stripe_customer_id: "cus_1", status }, null, false);
      expect(decision).toEqual({ kind: "already_subscribed" });
    }
  });

  it("a genuinely new user (no row at all) proceeds and is trial-eligible when requested", () => {
    const decision = decideCheckout(null, null, true);
    expect(decision).toEqual({ kind: "proceed", customerId: null, trialEligible: true });
  });

  it("a user with an existing Stripe customer but no live subscription reuses the customer id", () => {
    const decision = decideCheckout(
      { stripe_customer_id: "cus_existing", status: "incomplete" },
      null,
      false,
    );
    expect(decision).toEqual({ kind: "proceed", customerId: "cus_existing", trialEligible: false });
  });

  it("a previously-subscribed (now canceled) user is NOT trial-eligible even with withTrial=true", () => {
    const decision = decideCheckout(
      { stripe_customer_id: "cus_returning", status: "canceled" },
      null,
      true,
    );
    expect(decision).toEqual({ kind: "proceed", customerId: "cus_returning", trialEligible: false });
  });

  it("incomplete/incomplete_expired do NOT count as 'ever subscribed' — still trial-eligible", () => {
    for (const status of ["incomplete", "incomplete_expired"] as const) {
      const decision = decideCheckout({ stripe_customer_id: "cus_1", status }, null, true);
      expect(decision).toEqual({ kind: "proceed", customerId: "cus_1", trialEligible: true });
    }
  });
});
