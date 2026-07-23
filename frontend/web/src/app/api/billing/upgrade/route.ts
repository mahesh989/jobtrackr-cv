/**
 * POST /api/billing/upgrade
 *
 * Immediately upgrades the user's active subscription to a higher plan.
 * The old billing cycle ends now and a new one starts immediately — no
 * proration credit is applied for unused time on the previous plan.
 *
 * Body: { targetPlan: "monthly" | "unlimited" }
 * Returns: { success: true }
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { getStripe, priceIdForPlan } from "@/lib/billing/stripe";
import { getEntitlement }            from "@/lib/billing/entitlements";
import type { PlanId }               from "@/lib/billing/plans";
import { jsonError, withUser } from "@/lib/api-utils";

export const runtime = "nodejs";

const PLAN_RANK: Partial<Record<PlanId, number>> = {
  weekly:    1,
  monthly:   2,
  unlimited: 3,
};

export const POST = withUser(async (req: NextRequest, _ctx, { user }) => {

  const body = await req.json().catch(() => ({}));
  const targetPlan = body?.targetPlan as PlanId | undefined;

  if (!targetPlan || !(targetPlan in PLAN_RANK)) {
    return jsonError("Invalid target plan.", 400);
  }

  const ent = await getEntitlement(user.id);

  if (ent.access !== "full" || (ent.status !== "active" && ent.status !== "past_due")) {
    return NextResponse.json(
      { error: "Upgrades are only available on an active subscription." },
      { status: 422 },
    );
  }

  const currentRank = PLAN_RANK[ent.planId as PlanId] ?? 0;
  const targetRank  = PLAN_RANK[targetPlan] ?? 0;

  if (targetRank <= currentRank) {
    return NextResponse.json(
      { error: "Target plan must be higher than your current plan." },
      { status: 422 },
    );
  }

  const newPriceId = priceIdForPlan(targetPlan);
  if (!newPriceId) {
    return jsonError("Plan price not configured.", 500);
  }

  const admin = createAdminClient();
  const { data: sub } = await admin
    .from("subscriptions")
    .select("stripe_subscription_id")
    .eq("user_id", user.id)
    .maybeSingle();

  const subscriptionId = (sub as { stripe_subscription_id?: string } | null)?.stripe_subscription_id;
  if (!subscriptionId) {
    return jsonError("No active Stripe subscription found.", 422);
  }

  const stripe = getStripe();
  const stripeSub = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["items"],
  });

  const itemId = stripeSub.items?.data?.[0]?.id;
  if (!itemId) {
    return jsonError("Could not locate subscription item.", 500);
  }

  await stripe.subscriptions.update(subscriptionId, {
    items: [{ id: itemId, price: newPriceId }],
    proration_behavior: "none",
    billing_cycle_anchor: "now",
  });

  return NextResponse.json({ success: true });
});
