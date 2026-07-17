"use client";

import { useState } from "react";
import { Loader2, CreditCard, Check } from "lucide-react";
import { Button } from "@/ui";

const TRIAL_PERKS = [
  "3 tailored CVs",
  "3 cover letters",
  "1 search profile",
  "1 discovery run",
];

/**
 * Compact horizontal trial banner — sits above the plan cards so everything
 * fits in one viewport without scrolling.
 */
export function TrialHero() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startTrial() {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "monthly" }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error ?? "Could not start checkout.");
      window.location.assign(data.url as string);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-[var(--brand)]/30 bg-surface px-6 py-5">
      {/* Top row: headline + button */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xl font-bold text-text">3-day free trial</span>
            <span className="rounded-full bg-[var(--brand)]/10 px-2 py-0.5 text-[11px] font-semibold text-[var(--brand)]">
              No charge today
            </span>
          </div>
          <p className="text-xs text-text-2">
            After 3 days → <span className="font-medium text-text">A$19.99/month</span> (Monthly plan) · Cancel anytime before trial ends
          </p>
        </div>

        <Button
          onClick={startTrial}
          disabled={loading}
          className="shrink-0 flex items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed"
          style={{ background: "var(--brand)", color: "var(--brand-fg)" }}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
          {loading ? "Redirecting…" : "Start free trial"}
        </Button>
      </div>

      {/* Perks row */}
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-border pt-3">
        {TRIAL_PERKS.map((p) => (
          <span key={p} className="flex items-center gap-1 text-xs text-text-2">
            <Check className="h-3.5 w-3.5 shrink-0 text-[var(--brand)]" />
            {p}
          </span>
        ))}
        <span className="flex items-center gap-1 text-xs text-text-2">
          <Check className="h-3.5 w-3.5 shrink-0 text-[var(--brand)]" />
          Card required · not charged until trial ends
        </span>
      </div>

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
