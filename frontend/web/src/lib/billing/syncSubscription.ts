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

/** Resolve our user_id for a Stripe subscription, trying the cheap paths first. */
export async function resolveUserId(
  stripe: Stripe,
  sub: Stripe.Subscription,
  admin: ReturnType<typeof createAdminClient>,
): Promise<string | null> {
  const fromSub = (sub.metadata?.user_id as string | undefined) ?? null;
  if (fromSub) return fromSub;

  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const { data: row } = await admin
    .from("subscriptions").select("user_id").eq("stripe_customer_id", customerId).maybeSingle();
  if ((row as { user_id?: string } | null)?.user_id) return (row as { user_id: string }).user_id;

  // Last resort: read the customer's metadata.
  const customer = await stripe.customers.retrieve(customerId);
  if (!customer.deleted) {
    return (customer.metadata?.user_id as string | undefined) ?? null;
  }
  return null;
}

export async function upsertFromSubscription(stripe: Stripe, sub: Stripe.Subscription): Promise<void> {
  const admin = createAdminClient();
  const userId = await resolveUserId(stripe, sub, admin);
  if (!userId) {
    console.error("[billing] could not resolve user_id for sub", sub.id);
    return;
  }
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const item = sub.items.data[0];
  const priceId = item?.price?.id ?? null;
  // canceled subs keep their last plan_id; planForPriceId may still resolve it.
  const planId = planForPriceId(priceId) ?? (sub.metadata?.plan as string | undefined) ?? null;

  // As of the dahlia API the billing period lives on the subscription ITEM,
  // not the subscription object.
  await admin.from("subscriptions").upsert(
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
}
