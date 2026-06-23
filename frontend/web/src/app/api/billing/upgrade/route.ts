/**
 * POST /api/billing/upgrade
 *
 * Upgrades the user's active subscription to a higher plan immediately.
 * The old billing cycle ends now; the new plan's full price is charged today.
 * Uses proration_behavior:'none' + billing_cycle_anchor:'now' so the user
 * gets no credit for unused time and their new cycle starts fresh.
 *
 * Body: { targetPlan: "monthly" | "unlimited" }
 * Response: { success: true }
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/lib/supabase/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { getStripe, priceIdForPlan } from "@/lib/billing/stripe";
import { getEntitlement }            from "@/lib/billing/entitlements";
import type { PlanId }               from "@/lib/billing/plans";

export const runtime = "nodejs";

const PLAN_RANK: Record<string, number> = { weekly: 1, monthly: 2, unlimited: 3 };

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const targetPlan = body?.targetPlan as string | undefined;

  if (!targetPlan || !(targetPlan in PLAN_RANK)) {
    return NextResponse.json({ error: "Invalid target plan." }, { status: 400 });
  }

  const ent = await getEntitlement(user.id);

  if (ent.access !== "full" && ent.status !== "past_due") {
    return NextResponse.json(
      { error: "Only active subscribers can upgrade. Please start a subscription first." },
      { status: 422 },
    );
  }

  if (ent.status === "trialing") {
    return NextResponse.json(
      { error: "You are on a free trial. Complete checkout to subscribe, then upgrade from there." },
      { status: 422 },
    );
  }

  const currentRank = PLAN_RANK[ent.planId] ?? 0;
  const targetRank  = PLAN_RANK[targetPlan];

  if (targetRank <= currentRank) {
    return NextResponse.json(
      { error: `You are already on ${ent.planId}. Choose a higher-tier plan to upgrade.` },
      { status: 422 },
    );
  }

  const newPriceId = priceIdForPlan(targetPlan as PlanId);
  if (!newPriceId) {
    return NextResponse.json(
      { error: "This plan is not configured for purchase. Contact support." },
      { status: 500 },
    );
  }

  const admin = createAdminClient();
  const { data: sub } = await admin
    .from("subscriptions")
    .select("stripe_subscription_id")
    .eq("user_id", user.id)
    .maybeSingle();

  const stripeSubId = (sub as { stripe_subscription_id?: string } | null)?.stripe_subscription_id;
  if (!stripeSubId) {
    return NextResponse.json(
      { error: "No active Stripe subscription found. Please contact support." },
      { status: 422 },
    );
  }

  const stripeSub = await getStripe().subscriptions.retrieve(stripeSubId);
  const itemId = stripeSub.items.data[0]?.id;
  if (!itemId) {
    return NextResponse.json(
      { error: "Could not locate the subscription item. Please contact support." },
      { status: 500 },
    );
  }

  await getStripe().subscriptions.update(stripeSubId, {
    items: [{ id: itemId, price: newPriceId }],
    proration_behavior: "none",
    billing_cycle_anchor: "now",
  });

  return NextResponse.json({ success: true });
}
