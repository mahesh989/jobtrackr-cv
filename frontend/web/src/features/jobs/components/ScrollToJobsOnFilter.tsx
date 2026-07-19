"use client";

import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";

// Filter/sort params that should pull the user's eye down to the results.
const WATCH = [
  "stage", "triage", "ats", "status", "source",
  "min_keywords", "posted_within", "location", "visa_toggle",
  "sort", "dir",
] as const;

/**
 * Scrolls the job board into view when a filter/sort param changes AND the
 * board is currently off-screen (below the fold).  Clicking a donut CTA or
 * a filter chip from the top of the page still pulls the user down to the
 * results — but once they're already browsing the list, chip changes filter
 * in-place without yanking the viewport back up.
 *
 * Skips the very first render so a normal page load (or a deep link with
 * filter params) doesn't auto-scroll on arrival.
 */
export function ScrollToJobsOnFilter({ targetId = "jobs-board" }: { targetId?: string }) {
  const sp = useSearchParams();
  const key = WATCH.map((k) => sp.get(k) ?? "").join("|");
  const prevKey = useRef<string | null>(null);

  useEffect(() => {
    // First mount: record the key and skip (don't scroll on initial page load).
    if (prevKey.current === null) {
      prevKey.current = key;
      return;
    }
    if (prevKey.current === key) return;
    prevKey.current = key;

    const el = document.getElementById(targetId);
    if (!el) return;

    // Only scroll if the board header is currently BELOW the visible viewport
    // (i.e. user hasn't scrolled there yet).  rect.top > 0 means the top edge
    // is still below the viewport top; add a small buffer for sticky headers.
    const rect = el.getBoundingClientRect();
    if (rect.top > 80) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [key, targetId]);

  return null;
}
