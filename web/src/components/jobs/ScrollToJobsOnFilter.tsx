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
 * Smoothly scrolls the job board into view whenever a filter/sort param
 * changes — so clicking a donut "View X jobs" CTA, a funnel stage, or any
 * filter control lands the user on the (titled) results table instead of
 * leaving them staring at the chart wondering if anything happened.
 *
 * Skips the very first render so a normal page load (or a deep link that
 * already carries filter params) doesn't yank the viewport unexpectedly.
 */
export function ScrollToJobsOnFilter({ targetId = "jobs-board" }: { targetId?: string }) {
  const sp = useSearchParams();
  const key = WATCH.map((k) => sp.get(k) ?? "").join("|");
  const first = useRef(true);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const el = document.getElementById(targetId);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [key, targetId]);

  return null;
}
