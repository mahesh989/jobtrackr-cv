"use client";

import { useState } from "react";
import { Loader2, ArrowUpRight } from "lucide-react";
import { PUBLIC_PLANS, formatAud, type PlanDisplay } from "@/lib/billing/plans";
import { Button } from "@/components/ui";

const PLAN_RANK: Record<string, number> = { weekly: 1, monthly: 2, unlimited: 3 };

/** One-line pitch per plan — shown in the compact upgrade rows. */
const PLAN_PITCH: Record<string, string> = {
  monthly:   "250 tailored CVs & cover letters / month · 10 profiles",
  unlimited: "No caps on anything · priority support",
};

/**
 * Compact "Change plan" rows for active subscribers who aren't on the top
 * tier. Deliberately NOT the marketing cards — a paying customer just needs
 * plan, price, delta, button. Upgrading requires an inline confirm (it
 * charges the card on file immediately).
 */
export function UpgradeOptions({ currentPlanId }: { currentPlanId: string }) {
  const currentRank = PLAN_RANK[currentPlanId] ?? 0;
  const upgradeable = PUBLIC_PLANS.filter((p) => (PLAN_RANK[p.id] ?? 0) > currentRank);

  const [loading, setLoading] = useState<string | null>(null);
  const [armed, setArmed]     = useState<string | null>(null);
  const [error, setError]     = useState<string | null>(null);

  async function confirm(planId: string) {
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
      window.location.assign("/billing?upgraded=1");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setLoading(null);
      setArmed(null);
    }
  }

  if (upgradeable.length === 0) return null;

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="text-sm font-semibold text-text">Change plan</h2>

      {error && (
        <div className="mt-3 rounded-lg border border-[var(--red)]/30 bg-[var(--red-light)] px-3 py-2 text-label text-[var(--red)]">
          {error}
        </div>
      )}

      <ul className="mt-3 divide-y divide-[var(--border-muted)]">
        {upgradeable.map((plan) => (
          <UpgradeRow
            key={plan.id}
            plan={plan}
            armed={armed === plan.id}
            loading={loading === plan.id}
            disabled={loading !== null}
            onArm={() => { setError(null); setArmed(plan.id); }}
            onCancel={() => setArmed(null)}
            onConfirm={() => confirm(plan.id)}
          />
        ))}
      </ul>

      <p className="mt-3 text-caption text-text-3">
        Downgrades and cancellations are handled in Manage subscription above.
      </p>
    </section>
  );
}

function UpgradeRow({
  plan, armed, loading, disabled, onArm, onCancel, onConfirm,
}: {
  plan: PlanDisplay;
  armed: boolean;
  loading: boolean;
  disabled: boolean;
  onArm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <li className="py-3 first:pt-1 last:pb-1">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-text">{plan.displayName}</span>
            <span className="text-label text-text-2">
              {formatAud(plan.priceCents)} / {plan.interval}
            </span>
          </div>
          <p className="mt-0.5 text-caption text-text-3">{PLAN_PITCH[plan.id] ?? plan.blurb}</p>
        </div>

        {!armed && (
          <Button size="sm" onClick={onArm} disabled={disabled}>
            <ArrowUpRight className="h-3.5 w-3.5" />
            Upgrade
          </Button>
        )}
      </div>

      {armed && (
        <div className="mt-2 rounded-lg border border-[var(--amber)]/30 bg-[var(--amber-light)] px-3 py-2.5">
          <p className="text-label text-[var(--amber)]">
            Your card is charged <strong>{formatAud(plan.priceCents)}</strong> now and a new billing
            cycle starts today. Unused time on your current plan isn&apos;t credited.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button variant="brand" size="sm" onClick={onConfirm} disabled={loading}>
              {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {loading ? "Upgrading…" : `Confirm — ${formatAud(plan.priceCents)}`}
            </Button>
            <Button size="sm" onClick={onCancel} disabled={loading}>
              Keep current plan
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
