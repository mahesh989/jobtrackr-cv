/**
 * POST /api/billing/webhook — Stripe events (the ONLY writer of paid status).
 *
 * - Raw body + signature verification (Stripe replay/forgery protection).
 * - Idempotent: every event id is recorded in stripe_events; replays are no-ops.
 * - Syncs subscriptions table from the authoritative Stripe objects.
 *
 * Auto-renewal: Stripe renews subscriptions automatically each period and
 * auto-converts the 3-day trial to a paid charge. We mirror the resulting
 * state here; we never have to "renew" anything ourselves.
 *
 * Configure the endpoint URL + signing secret in the Stripe dashboard and set
 * STRIPE_WEBHOOK_SECRET. Events to enable: checkout.session.completed,
 * customer.subscription.{created,updated,deleted}, invoice.paid,
 * invoice.payment_failed.
 */

import { NextRequest, NextResponse } from "next/server";
import type Stripe                   from "stripe";
import { createAdminClient }         from "@/lib/supabase/admin";
import { getStripe, STRIPE_WEBHOOK_SECRET, planForPriceId } from "@/lib/billing/stripe";
import { jsonError } from "@/lib/api-utils";

export const runtime = "nodejs";

function iso(unixSeconds: number | null | undefined): string | null {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;
}

/** Resolve our user_id for a Stripe subscription, trying the cheap paths first. */
async function resolveUserId(
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

async function upsertFromSubscription(stripe: Stripe, sub: Stripe.Subscription) {
  const admin = createAdminClient();
  const userId = await resolveUserId(stripe, sub, admin);
  if (!userId) {
    console.error("[billing/webhook] could not resolve user_id for sub", sub.id);
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

export async function POST(req: NextRequest) {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return jsonError("No signature", 400);

  const stripe = getStripe();
  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, STRIPE_WEBHOOK_SECRET());
  } catch (err) {
    console.error("[billing/webhook] signature verify failed:", err instanceof Error ? err.message : err);
    return jsonError("Invalid signature", 400);
  }

  const admin = createAdminClient();

  // Idempotency: insert event id; if it already exists, this is a replay.
  const { error: dupeErr } = await admin
    .from("stripe_events").insert({ event_id: event.id, type: event.type });
  if (dupeErr) {
    // Unique violation = already processed. Anything else, log but ack 200 so
    // Stripe doesn't hammer retries on a transient DB blip.
    if (dupeErr.code === "23505") return NextResponse.json({ received: true, duplicate: true });
    console.error("[billing/webhook] dedupe insert error:", dupeErr.message);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.subscription) {
          const subId = typeof session.subscription === "string"
            ? session.subscription : session.subscription.id;
          const sub = await stripe.subscriptions.retrieve(subId);
          await upsertFromSubscription(stripe, sub);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        await upsertFromSubscription(stripe, event.data.object as Stripe.Subscription);
        break;
      }
      case "invoice.paid":
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const subRef = (invoice as unknown as { subscription?: string | Stripe.Subscription }).subscription;
        if (subRef) {
          const subId = typeof subRef === "string" ? subRef : subRef.id;
          const sub = await stripe.subscriptions.retrieve(subId);
          await upsertFromSubscription(stripe, sub);
        }
        break;
      }
      default:
        // Unhandled event types are acknowledged so Stripe stops retrying.
        break;
    }
  } catch (err) {
    console.error("[billing/webhook] handler error:", err instanceof Error ? err.message : err);
    // 500 → Stripe retries with backoff (idempotency makes that safe).
    return jsonError("Handler failed", 500);
  }

  return NextResponse.json({ received: true });
}
