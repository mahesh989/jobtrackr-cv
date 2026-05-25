"use client";

/**
 * SetupReturnBar — a sticky "← Back to setup guide · Step N of X" banner.
 *
 * Mounted once in the dashboard layout. It only renders when a page was
 * reached via a SetupGuide CTA, which appends `?from=setup&step=N&return=…`.
 * This lets every setup target page (profile, CV, integrations, …) offer a
 * one-click trip back to the exact step the user left from — with no
 * per-page wiring, including the three steps that all point at /integrations.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { SETUP_STEP_COUNT } from "./SetupGuide";

export function SetupReturnBar() {
  const params = useSearchParams();
  if (params.get("from") !== "setup") return null;

  const rawReturn = params.get("return");
  // Only honour internal paths — never an absolute/external URL.
  const ret = rawReturn && rawReturn.startsWith("/") ? rawReturn : "/dashboard/instructions";

  const stepNum = Number(params.get("step"));
  const step = Number.isFinite(stepNum) && stepNum >= 1 ? stepNum : null;

  return (
    <div className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-border bg-[var(--brand)]/10 px-6 py-2.5 backdrop-blur">
      <Link
        href={ret}
        className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--brand)] hover:underline"
      >
        <ChevronLeft className="w-3.5 h-3.5" />
        Back to setup guide
      </Link>
      {step && (
        <span className="text-[11px] text-text-2">
          Step {step} of {SETUP_STEP_COUNT}
        </span>
      )}
    </div>
  );
}
