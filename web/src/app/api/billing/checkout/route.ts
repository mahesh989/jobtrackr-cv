/**
 * POST /api/billing/checkout  { plan: "weekly"|"monthly"|"unlimited" }
 *
 * Starts a Stripe Checkout session in subscription mode with a 3-day trial
 * (card collected upfront, charged automatically when the trial ends — i.e.
 * auto-renewal is on by Stripe default). Reuses the user's Stripe customer if
 * one exists. Returns { url } for the browser to redirect to.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/lib/supabase/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { getStripe, priceIdForPlan } from "@/lib/billing/stripe";
import { TRIAL_DAYS, type PlanId }   from "@/lib/billing/plans";

export const runtime = "nodejs";

const PURCHASABLE: PlanId[] = ["weekly", "monthly", "unlimited"];

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let plan: PlanId;
  try {
    const body = await req.json();
    plan = (body as { plan?: PlanId }).plan as PlanId;
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (!PURCHASABLE.includes(plan)) {
    return NextResponse.json({ error: "Unknown plan" }, { status: 400 });
  }

  const priceId = priceIdForPlan(plan);
  if (!priceId) {
    return NextResponse.json(
      { error: `No Stripe price configured for ${plan}. Set STRIPE_PRICE_${plan.toUpperCase()}.` },
      { status: 500 },
    );
  }

  const stripe = getStripe();
  const admin = createAdminClient();

  // Reuse an existing Stripe customer if we have one; else create one.
  const { data: existing } = await admin
    .from("subscriptions").select("stripe_customer_id, status").eq("user_id", user.id).maybeSingle();
  let customerId = (existing as { stripe_customer_id?: string } | null)?.stripe_customer_id ?? null;

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

  // Only NEW customers (never trialed) get the free trial.
  const everSubscribed = !!(existing as { status?: string } | null)?.status &&
    !["incomplete", "incomplete_expired"].includes((existing as { status: string }).status);

  const origin = req.headers.get("origin")
    ?? process.env.NEXT_PUBLIC_SITE_URL
    ?? "https://jobtrackr-cv.vercel.app";

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      ...(everSubscribed ? {} : { trial_period_days: TRIAL_DAYS }),
      metadata: { user_id: user.id, plan },
    },
    client_reference_id: user.id,
    allow_promotion_codes: true,
    success_url: `${origin}/dashboard/billing?checkout=success`,
    cancel_url:  `${origin}/onboarding/plan?checkout=cancelled`,
  });

  return NextResponse.json({ url: session.url });
}
