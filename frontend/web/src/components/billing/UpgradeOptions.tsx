"use client";

import { useState } from "react";
import { Check, Loader2, ArrowUpCircle } from "lucide-react";
import { PUBLIC_PLANS, formatAud } from "@/lib/billing/plans";

const PLAN_RANK: Record<string, number> = { weekly: 1, monthly: 2, unlimited: 3 };

/**
 * Renders upgrade cards for all plans ranked higher than the user's current plan.
 * Shown on the billing dashboard when the user has an active/past_due subscription
 * and is not already on the highest tier (unlimited).
 */
export function UpgradeOptions({ currentPlanId }: { currentPlanId: string }) {
  const currentRank = PLAN_RANK[currentPlanId] ?? 0;
  const upgradeable = PUBLIC_PLANS.filter((p) => (PLAN_RANK[p.id] ?? 0) > currentRank);

  const [armed, setArmed]   = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError]   = useState<string | null>(null);

  async function doUpgrade(planId: string) {
    setError(null);
    setLoading(planId);
    try {
      const res = await fetch("/api/billing/upgrade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetPlan: planId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Upgrade failed.");
      window.location.assign("/dashboard/billing?upgraded=1");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setLoading(null);
      setArmed(null);
    }
  }

  if (upgradeable.length === 0) return null;

  return (
    <div className="rounded-xl border border-border bg-surface p-5 space-y-4">
      <div className="flex items-center gap-2">
        <ArrowUpCircle className="h-4 w-4 text-[var(--brand)]" />
        <h2 className="text-sm font-semibold text-text">Upgrade your plan</h2>
      </div>
      <p className="text-xs text-text-2">
        Your current plan ends immediately and the new plan&apos;s full price is charged today.
      </p>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {upgradeable.map((plan) => {
          const isArmed   = armed === plan.id;
          const isLoading = loading === plan.id;
          const featured  = plan.id === "unlimited";

          return (
            <div
              key={plan.id}
              className={
                "relative flex flex-col rounded-xl border p-5 " +
                (featured
                  ? "border-[var(--brand)] shadow-sm ring-1 ring-[var(--brand)]/20"
                  : "border-border")
              }
            >
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

              <div className="mt-5 space-y-2">
                {isArmed && !isLoading && (
                  <p className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
                    You&apos;ll be charged <strong>{formatAud(plan.priceCents)}</strong> now. Your current plan ends immediately.
                  </p>
                )}
                <div className="flex gap-2">
                  {isArmed && !isLoading && (
                    <button
                      onClick={() => setArmed(null)}
                      className="gh-btn flex-1 text-sm"
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    onClick={() => {
                      if (!isArmed) { setArmed(plan.id); return; }
                      doUpgrade(plan.id);
                    }}
                    disabled={loading !== null}
                    className={
                      "flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-60 " +
                      (featured || isArmed
                        ? "bg-[var(--brand)] text-[var(--brand-fg)] hover:opacity-90"
                        : "gh-btn")
                    }
                  >
                    {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                    {isLoading
                      ? "Upgrading…"
                      : isArmed
                      ? "Confirm upgrade"
                      : `Upgrade to ${plan.displayName}`}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
