/**
 * POST /api/billing/webhook — Stripe events (the ONLY writer of paid status).
 *
 * - Raw body + signature verification (Stripe replay/forgery protection).
 * - Idempotent: every event id is claimed in stripe_events for the duration
 *   of the handler. A genuine replay of an already-SUCCEEDED event is a
 *   no-op; a retry after a FAILED attempt re-runs the handler instead of
 *   being swallowed as a duplicate (see lib/billing/webhookIdempotency.ts).
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
import { getStripe, STRIPE_WEBHOOK_SECRET } from "@/lib/billing/stripe";
import { upsertFromSubscription } from "@/lib/billing/syncSubscription";
import { jsonError } from "@/lib/api-utils";
import { runIdempotent, type IdempotencyStore } from "@/lib/billing/webhookIdempotency";

export const runtime = "nodejs";

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

  // Idempotency store backed by stripe_events. Claim = insert; on a
  // transient handler failure the claim is RELEASED (row deleted) so
  // Stripe's retry re-runs the handler instead of being permanently
  // swallowed as a duplicate — see BUG #36 / webhookIdempotency.ts.
  const store: IdempotencyStore = {
    async claim(eventId, type) {
      const { error: dupeErr } = await admin
        .from("stripe_events").insert({ event_id: eventId, type });
      if (dupeErr) {
        // Unique violation = already claimed (in progress or processed).
        // Anything else, log but proceed — a transient insert error must
        // not silently drop a Stripe event.
        if (dupeErr.code === "23505") return { duplicate: true };
        console.error("[billing/webhook] dedupe insert error:", dupeErr.message);
      }
      return { duplicate: false };
    },
    async release(eventId) {
      const { error } = await admin.from("stripe_events").delete().eq("event_id", eventId);
      if (error) {
        // Best-effort: the row will sit as a false "processed" record until
        // manually cleared, but this must not crash the retry response.
        console.error("[billing/webhook] dedupe release error:", error.message);
      }
    },
  };

  const outcome = await runIdempotent(store, event.id, event.type, async () => {
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
  });

  if (outcome.status === "duplicate") {
    return NextResponse.json({ received: true, duplicate: true });
  }
  if (outcome.status === "failed") {
    const err = outcome.error;
    console.error("[billing/webhook] handler error:", err instanceof Error ? err.message : err);
    // 500 → Stripe retries with backoff. The dedupe claim was released
    // above, so the retry re-runs the handler instead of being swallowed.
    return jsonError("Handler failed", 500);
  }

  return NextResponse.json({ received: true });
}
