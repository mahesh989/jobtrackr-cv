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
import { runIdempotent, outcomeToHttpResponse } from "@/lib/billing/webhookIdempotency";
import { createStripeEventStore } from "@/lib/billing/stripeEventStore";

export const runtime = "nodejs";
// stripeEventStore.ts's claim staleness window (45s) is sized just above
// this — keep them in sync if either changes (independent review, round 2).
export const maxDuration = 20;

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

  // Idempotency store backed by stripe_events, via the claim_stripe_event()
  // Postgres function (migrations/011_stripe_events_claim_status.sql) — a
  // durable status column + row-locked atomic claim decision, replacing
  // the original insert/delete design (BUG #36) once its own two residuals
  // (BUG-25 F3/F4 — no forensic trace, no ownership token on release) were
  // found by independent review. See stripeEventStore.ts.
  const store = createStripeEventStore(admin);

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
        // Re-fetch rather than trust event.data.object — that snapshot is
        // frozen at event-creation time, and this fix (BUG #36) makes a
        // FAILED event replayable on Stripe's own retry schedule (up to
        // ~3 days later). Passing the stale snapshot straight through would
        // let a late retry overwrite a newer, correct status with an old
        // one — e.g. a stale "active" clobbering a since-recorded
        // "canceled", with no further event ever arriving to correct it
        // (independent review of this chunk, live-traced against
        // entitlements.ts's active/trialing/past_due -> access:"full"
        // branch). Subscriptions are never hard-deleted at Stripe, so
        // retrieving after .deleted still returns it, with status
        // "canceled" — safe. Matches the re-fetch pattern the other two
        // branches below already use.
        const snapshot = event.data.object as Stripe.Subscription;
        const sub = await stripe.subscriptions.retrieve(snapshot.id);
        await upsertFromSubscription(stripe, sub);
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

  if (outcome.status === "failed") {
    const err = outcome.error;
    console.error("[billing/webhook] handler error:", err instanceof Error ? err.message : err);
  }
  if (outcome.status === "in-flight") {
    // Greppable — this is the one operationally interesting new signal
    // this chunk introduces: it means concurrent deliveries of the same
    // event are genuinely happening, and it will show up as a "failed"
    // 409 delivery in the Stripe dashboard (round-2 review, N3). Expected
    // and self-resolving (Stripe's own retry converges once the
    // original claim settles), not a real failure.
    console.warn("[billing/webhook] CLAIM_IN_FLIGHT_409 — genuinely concurrent delivery of a still-fresh claim, asking Stripe to retry:", event.id);
  }
  // outcomeToHttpResponse is the actual fix for BUG-25 F3 (independent
  // review, round 2): "duplicate" (a TRUE, already-succeeded duplicate)
  // gets a 2xx; "in-flight" (a genuinely concurrent delivery whose
  // original claim is still fresh and might yet fail) does NOT — Stripe
  // must keep retrying it rather than receive a false all-clear.
  const { status, body } = outcomeToHttpResponse(outcome);
  return NextResponse.json(body, { status });
}
