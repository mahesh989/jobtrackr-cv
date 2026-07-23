/**
 * GET /api/billing/checkout/confirm?session_id=cs_...
 *
 * Stripe Checkout success_url lands HERE first (not directly on
 * /instructions). Closes a real race: Stripe's checkout.session.completed
 * webhook can take anywhere from under a second to several seconds (or need
 * a retry) to land, but the browser redirect from Checkout is immediate. If
 * the dashboard layout's entitlement gate runs before the webhook has
 * written the `subscriptions` row, it reads status="none" and bounces a
 * user who JUST PAID straight back to /onboarding/plan — "the page got
 * stuck" until a manual refresh gave the webhook time to catch up.
 *
 * This route retrieves the Checkout Session directly from Stripe and
 * upserts the subscription synchronously, in the same request that's about
 * to hit the entitlement gate — so the row is guaranteed to exist before
 * the redirect into /instructions. The webhook is untouched and remains the
 * resilient source of truth for every subsequent event.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/billing/stripe";
import { upsertFromSubscription } from "@/lib/billing/syncSubscription";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const dest = `${origin}/instructions?tab=setup&checkout=success`;

  const sessionId = req.nextUrl.searchParams.get("session_id");
  if (!sessionId) return NextResponse.redirect(dest);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${origin}/auth/login`);

  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Only sync a session that actually belongs to the logged-in user —
    // client_reference_id is set to user.id at checkout creation time.
    if (session.client_reference_id === user.id && session.subscription) {
      const subId = typeof session.subscription === "string"
        ? session.subscription : session.subscription.id;
      const sub = await stripe.subscriptions.retrieve(subId);
      await upsertFromSubscription(stripe, sub);
    }
  } catch (err) {
    // Never block the user on a Stripe/DB hiccup here — the webhook is the
    // resilient fallback; worst case they see the same pre-existing race
    // this route exists to close, not a new failure mode.
    console.error("[billing/checkout/confirm] sync failed:", err instanceof Error ? err.message : err);
  }

  return NextResponse.redirect(dest);
}
