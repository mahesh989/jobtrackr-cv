/**
 * Shared Stripe subscription → `subscriptions` table sync.
 *
 * Extracted from the webhook handler so the SAME upsert logic can also run
 * synchronously right after a successful Checkout redirect (see
 * /api/billing/checkout/confirm) — closing the race where Stripe's webhook
 * hasn't landed yet by the time the browser reaches the dashboard, and the
 * layout's entitlement gate (still reading "none") bounces the user back to
 * /onboarding/plan even though they just paid. The webhook remains the
 * resilient async source of truth for every OTHER subscription event
 * (renewals, cancellations, payment failures); this is only a same-request
 * fast path for the one moment latency is user-visible.
 */
import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { planForPriceId } from "@/lib/billing/stripe";

function iso(unixSeconds: number | null | undefined): string | null {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;
}

/**
 * Resolve our user_id for a Stripe subscription, trying the cheap paths first.
 *
 * ⚠️ DO NOT DELETE AS "DEAD CODE" — a grep for cross-file imports of
 * `resolveUserId` finds none because its sole caller, `upsertFromSubscription`
 * below, is IN THIS SAME FILE. That function has 5 call sites across
 * api/billing/webhook/route.ts and api/billing/checkout/confirm/route.ts.
 * Deleting this breaks Stripe subscription sync entirely (mis-flagged dead
 * once already — audit finding #63).
 */
export async function resolveUserId(
  stripe: Stripe,
  sub: Stripe.Subscription,
  admin: ReturnType<typeof createAdminClient>,
): Promise<string | null> {
  const fromSub = (sub.metadata?.user_id as string | undefined) ?? null;
  if (fromSub) return fromSub;

  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const { data: row, error } = await admin
    .from("subscriptions").select("user_id").eq("stripe_customer_id", customerId).maybeSingle();
  if (error) {
    // Logged, not swallowed (BUG-26) — the Stripe customer-metadata fallback
    // below usually self-heals this, but a silent DB error here is still a
    // visibility gap worth a trace.
    console.error(`[billing] resolveUserId DB lookup failed for customer ${customerId}:`, error.message);
  }
  if ((row as { user_id?: string } | null)?.user_id) return (row as { user_id: string }).user_id;

  // Last resort: read the customer's metadata.
  const customer = await stripe.customers.retrieve(customerId);
  if (!customer.deleted) {
    return (customer.metadata?.user_id as string | undefined) ?? null;
  }
  return null;
}

export async function upsertFromSubscription(
  stripe: Stripe,
  sub: Stripe.Subscription,
  admin: ReturnType<typeof createAdminClient> = createAdminClient(),
): Promise<void> {
  const userId = await resolveUserId(stripe, sub, admin);
  if (!userId) {
    // MUST throw, not log-and-return (BUG-26). Both callers already handle a
    // thrown error correctly (checkout/confirm's catch logs it and still
    // redirects; the webhook's catch returns 500 so Stripe retries and, since
    // #36's fix, its dedupe claim is released first) — but log-and-return let
    // the webhook's runIdempotent read this as a SUCCESSFUL handler
    // completion, permanently and silently dropping the sync with no trace
    // and no further chance to recover.
    throw new Error(`[billing] could not resolve user_id for sub ${sub.id}`);
  }
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const item = sub.items.data[0];
  const priceId = item?.price?.id ?? null;
  // canceled subs keep their last plan_id; planForPriceId may still resolve it.
  const planId = planForPriceId(priceId) ?? (sub.metadata?.plan as string | undefined) ?? null;

  // As of the dahlia API the billing period lives on the subscription ITEM,
  // not the subscription object.
  //
  // MUST check `error` and throw. supabase-js never throws on a Postgrest
  // error — it resolves { data, error } — and this call's result used to be
  // discarded entirely (2026-08-09 fix). Both callers already have correct
  // handling for a thrown error (checkout/confirm's catch logs it and still
  // redirects; the webhook's catch returns 500 so Stripe retries with
  // backoff), but neither could ever engage it: a failed write here was
  // completely invisible, so a user whose row failed to upsert — a Stripe
  // status the DB's CHECK constraint doesn't allow (e.g. `paused`), or any
  // transient blip — got redirected as if it had succeeded, then bounced
  // back to /onboarding/plan by the dashboard's entitlement gate forever,
  // with no error anywhere and no retry ever firing.
  const { error } = await admin.from("subscriptions").upsert(
    {
      user_id:                userId,
      stripe_customer_id:     customerId,
      stripe_subscription_id: sub.id,
      plan_id:                planId,
      status:                 sub.status,
      current_period_start:   iso(item?.current_period_start),
      current_period_end:     iso(item?.current_period_end),
      trial_end:              iso(sub.trial_end),
      cancel_at_period_end:   sub.cancel_at_period_end,
      updated_at:             new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) {
    console.error(`[billing] subscriptions upsert failed for sub ${sub.id} (status=${sub.status}):`, error.message);
    throw new Error(`subscriptions upsert failed: ${error.message}`);
  }
}
