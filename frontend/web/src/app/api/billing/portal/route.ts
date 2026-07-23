/**
 * POST /api/billing/portal
 *
 * Opens the Stripe-hosted Billing Portal so the user can update their card,
 * switch plan, view invoices, or cancel (cancel = at period end → our webhook
 * flips cancel_at_period_end, access stays full until the period rolls over,
 * then entitlement goes read-only). Returns { url }.
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { getStripe }                 from "@/lib/billing/stripe";
import { jsonError, withUser } from "@/lib/api-utils";

export const runtime = "nodejs";

export const POST = withUser(async (req: NextRequest, _ctx, { user }) => {

  const admin = createAdminClient();
  const { data: sub } = await admin
    .from("subscriptions").select("stripe_customer_id").eq("user_id", user.id).maybeSingle();
  const customerId = (sub as { stripe_customer_id?: string } | null)?.stripe_customer_id ?? null;

  if (!customerId) {
    return jsonError("No billing account yet — start a plan first.", 422);
  }

  const origin = req.headers.get("origin")
    ?? process.env.NEXT_PUBLIC_SITE_URL
    ?? "https://jobtrackr-cv.vercel.app";

  const portal = await getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${origin}/billing`,
  });

  return NextResponse.json({ url: portal.url });
});
