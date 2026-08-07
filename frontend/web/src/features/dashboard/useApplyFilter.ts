"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { shallowSetParams } from "@/features/jobs/lib/shallowNav";

// View-filter params the dashboard's analytics surfaces can set; cleared
// before applying a new one so the chosen slice is shown cleanly (dataset
// filters like location are kept).
// `job` belongs here too: it's leftover detail-pane selection state, not a
// dataset filter, and a stale one survives this merge otherwise — landing on
// the Applied flat list with the previously-open job pre-expanded even though
// that view's whole design is "no auto-expand, detail only on explicit click".
const DONUT_VIEW_KEYS = ["stage", "triage", "ats", "status", "chips", "job"];

/**
 * Apply a dashboard filter instantly client-side (History API) and scroll to
 * the results, instead of a full server navigation.
 *
 * Extracted from PipelineDonut so surfaces rendered OUTSIDE the donut — the
 * callout action bar in particular — can trigger the same instant filtering
 * without being passed a callback down from it. It closes over nothing but
 * Next's own routing hooks, so it is safe to call from any client component
 * on the dashboard route.
 */
export function useApplyFilter(): (href: string) => void {
  const pathname = usePathname();
  const sp       = useSearchParams();

  return function applyFilter(href: string) {
    try {
      const u = new URL(href, window.location.origin);
      const params = new URLSearchParams(sp.toString());
      DONUT_VIEW_KEYS.forEach((k) => params.delete(k));
      u.searchParams.forEach((val, key) => params.set(key, val));
      shallowSetParams(pathname, params);
      document.getElementById("jobs-board")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch { /* noop */ }
  };
}
