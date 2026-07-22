"use client";

import { useState } from "react";
import { Loader2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui";

/**
 * Opens the Stripe Billing Portal (POST /api/billing/portal → { url }).
 * Used to update card, switch plan, view invoices, or cancel.
 *
 * Navigates in the SAME tab — the portal session's return_url brings the
 * user straight back to /billing, and same-tab avoids popup blockers.
 */
export function ManageButton({
  label = "Manage subscription",
  variant = "default",
}: {
  label?: string;
  variant?: "default" | "brand";
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
      // keep the spinner while the browser navigates away
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setLoading(false);
    }
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <Button variant={variant} size="sm" onClick={openPortal} disabled={loading}>
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
        {label}
      </Button>
      {error && <span className="text-caption text-[var(--red)]">{error}</span>}
    </div>
  );
}
