/**
 * Pure decision logic for POST /api/billing/checkout (BUG #37).
 *
 * The route's existing-subscription SELECT discarded its `error`, so a
 * transient query failure (bad service-role key, DB blip) made `existing`
 * indistinguishable from "no subscription" — silently skipping the
 * double-billing guard, re-creating a Stripe customer that overwrote the
 * real one (upsert onConflict:"user_id"), and potentially re-granting a
 * trial to a user who already used one. Extracted so the three downstream
 * consequences of trusting a null `existing` are tested together, not
 * fixed piecemeal — matches this repo's convention of testing pure logic
 * out of an I/O orchestrator (see confirm.test.ts).
 */
import type { SubStatus } from "./plans";

export interface ExistingSubscriptionRow {
  stripe_customer_id?: string | null;
  status?: SubStatus | string | null;
}

export type CheckoutDecision =
  | { kind: "query_failed" }
  | { kind: "already_subscribed" }
  | { kind: "proceed"; customerId: string | null; trialEligible: boolean };

const LIVE_STATES: readonly string[] = ["active", "trialing", "past_due"];
const NEVER_REALLY_SUBSCRIBED_STATES: readonly string[] = ["incomplete", "incomplete_expired"];

export function decideCheckout(
  existing: ExistingSubscriptionRow | null,
  queryError: { message: string } | null,
  withTrial: boolean,
): CheckoutDecision {
  // MUST be checked first — everything below trusts `existing`, and a
  // query failure must never be silently read as "no subscription yet".
  if (queryError) return { kind: "query_failed" };

  const status = existing?.status ?? "";
  if (LIVE_STATES.includes(status)) {
    return { kind: "already_subscribed" };
  }

  // Two-door model: the trial exists only behind the explicit "Start free
  // trial" CTA, and only once per customer — anyone who previously held a
  // real subscription (even a since-cancelled one) pays directly.
  const everSubscribed = !!existing?.status && !NEVER_REALLY_SUBSCRIBED_STATES.includes(status);
  const trialEligible = withTrial && !everSubscribed;

  return {
    kind: "proceed",
    customerId: existing?.stripe_customer_id ?? null,
    trialEligible,
  };
}
