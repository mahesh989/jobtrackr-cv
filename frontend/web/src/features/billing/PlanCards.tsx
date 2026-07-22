"use client";

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { PUBLIC_PLANS, formatAud, TRIAL_DAYS, type PlanId } from "@/lib/billing/plans";
import { Button } from "@/components/ui";

/**
 * Plan-selection grid. Shared by /pricing and /onboarding/plan.
 *
 * Two-door model:
 *  - "Choose <plan>" buttons are DIRECT purchases — charged today, period
 *    starts today (Stripe checkout states the amount due before card entry).
 *  - The trial strip below the cards (shown when `showTrial`) is the ONLY
 *    trial door: A$0 today on Monthly, converts after 3 days. New customers
 *    only — the checkout route enforces once-per-customer.
 */
export function PlanCards({
  showTrial = true,
  currentPlan = null,
  hideButtons = false,
}: {
  showTrial?: boolean;
  currentPlan?: PlanId | null;
  /** Show plans for comparison only — no subscribe buttons (used on onboarding). */
  hideButtons?: boolean;
}) {
  const [loading, setLoading] = useState<PlanId | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function subscribe(plan: PlanId, withTrial = false) {
    setError(null);
    setLoading(plan);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, withTrial }),
      });
      if (res.status === 401) {
        // Not logged in — send them to sign up, then back to plan selection.
        window.location.assign("/auth/signup?next=/onboarding/plan");
        return;
      }
      if (res.status === 409) {
        // Already on a live subscription — checkout would double-bill.
        // Billing page has the change-plan / manage flows; the notice param
        // explains why they landed there.
        window.location.assign("/billing?notice=already_subscribed");
        return;
      }
      const data = await res.json();
      if (!res.ok || !data.url) {
        throw new Error(data.error ?? "Could not start checkout.");
      }
      window.location.assign(data.url as string);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setLoading(null);
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-3">
        {PUBLIC_PLANS.map((plan) => {
          const isCurrent = currentPlan === plan.id;
          const featured = plan.id === "monthly";
          return (
            <div
              key={plan.id}
              className={
                "relative flex flex-col rounded-xl border bg-surface p-5 " +
                (featured ? "border-[var(--brand)] shadow-sm ring-1 ring-[var(--brand)]/20" : "border-border")
              }
            >
              {featured && (
                <span className="absolute -top-2.5 left-5 rounded-full bg-[var(--brand)] px-2 py-0.5 text-micro font-bold uppercase tracking-wide text-[var(--brand-fg)]">
                  Best value
                </span>
              )}
              <h3 className="text-base font-semibold text-text">{plan.displayName}</h3>
              <p className="mt-1 text-xs text-text-2">{plan.blurb}</p>

              <div className="mt-3 flex items-baseline gap-1">
                <span className="text-2xl font-bold text-text">{formatAud(plan.priceCents)}</span>
                <span className="text-xs text-text-2">/ {plan.interval}</span>
              </div>

              <ul className="mt-4 flex-1 space-y-2">
                {plan.highlights.map((h) => (
                  <li key={h} className="flex items-start gap-2 text-xs text-text">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--brand)]" />
                    <span>{h}</span>
                  </li>
                ))}
              </ul>

              {!hideButtons && (
                <Button
                  variant={featured ? "brand" : "default"}
                  size="lg"
                  onClick={() => subscribe(plan.id)}
                  disabled={loading !== null || isCurrent}
                  className="mt-5 w-full justify-center"
                >
                  {loading === plan.id && <Loader2 className="h-4 w-4 animate-spin" />}
                  {isCurrent ? "Current plan" : loading === plan.id ? "Redirecting…" : `Choose ${plan.displayName}`}
                </Button>
              )}
            </div>
          );
        })}
      </div>
      {/* Dedicated trial doorway — for visitors who aren't ready to pick a
          plan. Checkout always needs a plan attached for the post-trial
          conversion, so this starts the trial on Monthly (the default,
          matching onboarding's TrialHero); they can switch or cancel any
          time before the trial ends. */}
      {showTrial && (
        <div className="flex flex-col items-center justify-between gap-3 rounded-xl border border-[var(--brand)]/30 bg-[var(--brand)]/5 px-5 py-4 sm:flex-row">
          <div className="text-center sm:text-left">
            <p className="text-sm font-semibold text-text">Not sure yet? Start with the free trial.</p>
            <p className="mt-0.5 text-xs text-text-2">
              {TRIAL_DAYS} days free — includes 3 tailored CVs and 3 cover letters. Card required, no
              charge today. Continues on Monthly ({formatAud(PUBLIC_PLANS.find((p) => p.id === "monthly")!.priceCents)}/month) unless you cancel or switch.
            </p>
          </div>
          <Button
            variant="brand"
            size="lg"
            onClick={() => subscribe("monthly", true)}
            disabled={loading !== null}
            className="shrink-0 justify-center"
          >
            {loading === "monthly" && <Loader2 className="h-4 w-4 animate-spin" />}
            {loading === "monthly" ? "Redirecting…" : "Start free trial"}
          </Button>
        </div>
      )}
    </div>
  );
}
