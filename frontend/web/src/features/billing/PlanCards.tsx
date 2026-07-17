"use client";

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { PUBLIC_PLANS, formatAud, TRIAL_DAYS, type PlanId } from "@/lib/billing/plans";
import { Button } from "@/ui";

/**
 * Plan-selection grid. Shared by /pricing and /onboarding/plan.
 *
 * Each "Subscribe" button POSTs to /api/billing/checkout and redirects the
 * browser to the returned Stripe Checkout URL. New customers get a 3-day trial
 * (card upfront); the trial copy is shown when `showTrial` is true.
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

  async function subscribe(plan: PlanId) {
    setError(null);
    setLoading(plan);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      if (res.status === 401) {
        // Not logged in — send them to sign up, then back to plan selection.
        window.location.assign("/auth/signup?next=/onboarding/plan");
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
                <span className="absolute -top-2.5 left-5 rounded-full bg-[var(--brand)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--brand-fg)]">
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
                  onClick={() => subscribe(plan.id)}
                  disabled={loading !== null || isCurrent}
                  className={
                    "mt-5 flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-60 " +
                    (featured
                      ? "bg-[var(--brand)] text-[var(--brand-fg)] hover:opacity-90"
                      : "")
                  }
                >
                  {loading === plan.id && <Loader2 className="h-4 w-4 animate-spin" />}
                  {isCurrent ? "Current plan" : loading === plan.id ? "Redirecting…" : showTrial ? "Start free trial" : "Choose this plan"}
                </Button>
              )}
            </div>
          );
        })}
      </div>
      {showTrial && (
        <p className="text-center text-xs text-text-2">
          New subscribers get a {TRIAL_DAYS}-day free trial — card required, cancel anytime before it ends.
          Auto-renews at the end of each period.
        </p>
      )}
    </div>
  );
}
