"use client";

import { useState } from "react";
import { Loader2, ExternalLink } from "lucide-react";

/**
 * Opens the Stripe Billing Portal (POST /api/billing/portal → { url }).
 * Used to update card, switch plan, view invoices, or cancel.
 */
export function ManageSubscriptionButton({
  label = "Manage subscription",
  className = "gh-btn",
}: {
  label?: string;
  className?: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openPortal() {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error ?? "Could not open billing portal.");
      window.location.assign(data.url as string);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setLoading(false);
    }
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        onClick={openPortal}
        disabled={loading}
        className={"inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold disabled:opacity-60 " + className}
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
        {label}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
