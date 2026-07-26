"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

/**
 * "Back" for the full analysis page.
 *
 * Was a fixed link to /analyses, which dumped the user on a list they may
 * never have been on — the usual entry point is "Full analysis ↗" from the
 * board's detail pane, and returning there means losing the open job, the
 * active filters and the scroll position.
 *
 * router.back() returns to whatever the user actually came from, restoring
 * that state for free. `/analyses` stays the fallback for a cold entry (a
 * bookmark, a new tab) where there is no in-app history to step back to.
 */
export function BackToBoardButton({ fallbackHref = "/analyses" }: { fallbackHref?: string }) {
  const router = useRouter();

  function goBack() {
    // A same-tab in-app navigation leaves history behind; a cold load doesn't.
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
      return;
    }
    router.push(fallbackHref);
  }

  return (
    <button
      type="button"
      onClick={goBack}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-[9px] border border-border bg-surface px-[14px] py-[8px] text-[13px] font-semibold text-text-2 transition-colors hover:bg-[var(--surface-2)] hover:text-text"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      Back
    </button>
  );
}
