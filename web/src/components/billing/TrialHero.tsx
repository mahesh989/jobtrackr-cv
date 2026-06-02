"use client";

import { useState } from "react";
import { Sparkles, Loader2, Check, CreditCard } from "lucide-react";

const TRIAL_PERKS = [
  "3 tailored CVs",
  "3 cover letters",
  "1 search profile",
  "1 discovery run",
];

/**
 * Prominent trial CTA on the onboarding/plan page.
 * Defaults to Monthly plan — clear auto-renewal + cancel disclosure.
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
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-[var(--brand)]/30 bg-surface p-8 text-center shadow-sm">
      {/* Icon */}
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--brand)]/10">
        <Sparkles className="h-7 w-7 text-[var(--brand)]" />
      </div>

      {/* Headline */}
      <h1 className="text-2xl font-bold text-text">3 days free</h1>
      <p className="mt-2 text-sm text-text-2">
        Try everything JobTrackr has to offer — no charge today.
      </p>

      {/* Perks */}
      <ul className="mt-5 flex flex-wrap justify-center gap-x-6 gap-y-2">
        {TRIAL_PERKS.map((p) => (
          <li key={p} className="flex items-center gap-1.5 text-sm text-text">
            <Check className="h-4 w-4 shrink-0 text-[var(--brand)]" />
            {p}
          </li>
        ))}
      </ul>

      {/* CTA button */}
      <button
        onClick={startTrial}
        disabled={loading}
        className="mt-6 w-full flex items-center justify-center gap-2 rounded-xl py-3.5 text-base font-semibold transition-opacity disabled:opacity-60"
        style={{ background: "var(--brand)", color: "var(--brand-fg)" }}
      >
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : (
          <CreditCard className="h-5 w-5" />
        )}
        {loading ? "Redirecting to checkout…" : "Start my free trial"}
      </button>

      {error && (
        <p className="mt-3 text-xs text-red-600">{error}</p>
      )}

      {/* Disclosure */}
      <div className="mt-4 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-left text-xs text-amber-800 space-y-1">
        <p>
          <span className="font-semibold">Card required</span> — you won&apos;t be charged during the 3-day trial.
        </p>
        <p>
          After 3 days, your card is automatically charged{" "}
          <span className="font-semibold">A$19.99/month</span> (Monthly plan).
          You can cancel anytime before the trial ends — no questions asked.
        </p>
      </div>

      <p className="mt-3 text-[11px] text-text-2">
        Want a different plan?{" "}
        <span className="font-medium text-[var(--brand)]">Compare plans below ↓</span>
      </p>
    </div>
  );
}
