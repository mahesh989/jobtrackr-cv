/**
 * POST /api/billing/checkout  { plan: "weekly"|"monthly"|"unlimited", withTrial?: boolean }
 *
 * Starts a Stripe Checkout session in subscription mode. Two doors:
 *  - withTrial (the explicit "Start free trial" CTA, new customers only) —
 *    A$0 today, card charged automatically when the 3-day trial ends.
 *  - default ("Choose <plan>" buttons) — direct purchase: charged today,
 *    billing period starts today.
 * Auto-renewal is on by Stripe default either way. Reuses the user's Stripe
 * customer if one exists. Returns { url } for the browser to redirect to.
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { getStripe, priceIdForPlan } from "@/lib/billing/stripe";
import { PLAN_IDS, TRIAL_DAYS, type PlanId } from "@/lib/billing/plans";
import { jsonError, withUser } from "@/lib/api-utils";

export const runtime = "nodejs";

const PURCHASABLE: PlanId[] = PLAN_IDS.filter((p) => p !== "trial" && p !== "comp");

export const POST = withUser(async (req: NextRequest, _ctx, { user }) => {

  let plan: PlanId;
  let withTrial = false;
  try {
    const body = await req.json() as { plan?: PlanId; withTrial?: boolean };
    plan = body.plan as PlanId;
    withTrial = body.withTrial === true;
  } catch {
    return jsonError("Invalid body", 400);
  }
  if (!PURCHASABLE.includes(plan)) {
    return jsonError("Unknown plan", 400);
  }

  const priceId = priceIdForPlan(plan);
  if (!priceId) {
    // Config problem, not a user problem — log the actionable detail, show a
    // human message.
    console.error(`[billing/checkout] No Stripe price configured for "${plan}" — set STRIPE_PRICE_${plan.toUpperCase()}.`);
    return NextResponse.json(
      { error: "Checkout isn't available right now — please try again in a few minutes." },
      { status: 500 },
    );
  }

  const stripe = getStripe();
  const admin = createAdminClient();

  // Reuse an existing Stripe customer if we have one; else create one.
  const { data: existing } = await admin
    .from("subscriptions").select("stripe_customer_id, status").eq("user_id", user.id).maybeSingle();
  let customerId = (existing as { stripe_customer_id?: string } | null)?.stripe_customer_id ?? null;

  // Guard: a live subscription means checkout would create a SECOND Stripe
  // subscription (double-billing). Plan changes for live subs go through
  // /api/billing/upgrade or the Stripe portal instead.
  const liveStates = ["active", "trialing", "past_due"];
  if (liveStates.includes((existing as { status?: string } | null)?.status ?? "")) {
    return NextResponse.json(
      { error: "You already have an active subscription — change your plan from the Billing page instead.", code: "already_subscribed" },
      { status: 409 },
    );
  }

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      metadata: { user_id: user.id },
    });
    customerId = customer.id;
    // Persist immediately so the webhook can resolve the user even if the
    // session is abandoned and re-started.
    await admin.from("subscriptions").upsert(
      { user_id: user.id, stripe_customer_id: customerId, status: "incomplete" },
      { onConflict: "user_id" },
    );
  }

  // Two-door model: the trial exists ONLY behind the explicit "Start free
  // trial" CTA (withTrial). "Choose <plan>" buttons are direct purchases —
  // charged today, period starts today. And even the trial door is once per
  // customer: anyone who previously held a real subscription pays directly.
  const everSubscribed = !!(existing as { status?: string } | null)?.status &&
    !["incomplete", "incomplete_expired"].includes((existing as { status: string }).status);
  const trialEligible = withTrial && !everSubscribed;

  const origin = req.headers.get("origin")
    ?? process.env.NEXT_PUBLIC_SITE_URL
    ?? "https://jobtrackr-cv.vercel.app";

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      ...(trialEligible ? { trial_period_days: TRIAL_DAYS } : {}),
      metadata: { user_id: user.id, plan },
    },
    client_reference_id: user.id,
    allow_promotion_codes: true,
    // Success lands on the setup wizard, not the billing page — a brand-new
    // subscriber's next job is profile + CV + first search, not invoices.
    success_url: `${origin}/instructions?tab=setup&checkout=success`,
    cancel_url:  `${origin}/onboarding/plan?checkout=cancelled`,
  });

  return NextResponse.json({ url: session.url });
});
