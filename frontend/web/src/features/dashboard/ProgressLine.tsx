"use client";

/**
 * One-line progress summary, replacing the old four-card KPI grid.
 *
 * "25 applied · 3 this week · 207 tracked" carries the same information the
 * Total and Applied cards did, in a fraction of the space, and adds the one
 * number that actually reflects effort: applications sent THIS WEEK. A
 * lifetime total only ever goes up, so it stops meaning anything; a weekly
 * count is the difference between "I'm moving" and "I've stalled".
 *
 * "New · unseen" survives as a real button rather than a stat, because it is
 * the one item here that names something to DO. It is omitted entirely at 0.
 *
 * Every navigation path the KPI cards owned is preserved:
 *   N new to review → ?status=new     (was: New · unseen card)
 *   N applied       → APPLIED_HREF    (was: Applied card)
 *   N tracked       → scroll/pulse the jobs board  (was: Total jobs card)
 */

import { useRouter, useSearchParams } from "next/navigation";
import { APPLIED_HREF } from "@/features/jobs/lib/boardViews";

const JOBS_BOARD_ID = "jobs-board";

export function ProgressLine({
  totalJobs,
  totalNew,
  totalApplied,
  appliedThisWeek,
}: {
  totalJobs: number;
  totalNew: number;
  totalApplied: number;
  appliedThisWeek: number;
}) {
  const router = useRouter();
  const sp = useSearchParams();

  function handleNewClick() {
    const params = new URLSearchParams(sp.toString());
    params.set("status", "new");
    router.push(`/dashboard?${params.toString()}`);
  }

  function rememberOrigin() {
    try {
      sessionStorage.setItem("lastDashboardTab", "/");
    } catch {
      /* sessionStorage unavailable — back button falls back to router.back() */
    }
  }

  function handleAppliedClick() {
    rememberOrigin();
    router.push(APPLIED_HREF);
  }

  // Kept from the old Total jobs card: if the board is already on screen,
  // pulse it rather than scrolling to something the user is looking at.
  function handleTotalClick() {
    const el = document.getElementById(JOBS_BOARD_ID);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const alreadyInView = rect.top >= 0 && rect.top < window.innerHeight * 0.5;
    if (alreadyInView) {
      el.classList.remove("pulse-highlight");
      void el.offsetWidth; // force reflow so the animation can restart
      el.classList.add("pulse-highlight");
      window.setTimeout(() => el.classList.remove("pulse-highlight"), 1000);
    } else {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  const linkCls =
    "font-semibold text-text hover:text-[var(--brand)] transition-colors " +
    "focus:outline-none focus-visible:underline";

  return (
    <div className="flex items-center gap-3 flex-wrap anim-in">
      {totalNew > 0 && (
        <button
          type="button"
          onClick={handleNewClick}
          className="inline-flex shrink-0 items-center gap-1.5 px-3 py-2 rounded-md text-label font-medium
                     bg-[var(--brand)]/10 border border-[var(--brand)]/30 text-[var(--brand)]
                     hover:bg-[var(--brand)]/15 transition-colors
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]/40"
        >
          {totalNew} new to review
        </button>
      )}

      <p className="text-body text-text-2">
        <button type="button" onClick={handleAppliedClick} className={linkCls}>
          {totalApplied.toLocaleString()} applied
        </button>
        {appliedThisWeek > 0 && (
          <span className="text-[#1A7F37] font-semibold"> · {appliedThisWeek} this week</span>
        )}
        {" · "}
        <button type="button" onClick={handleTotalClick} className={linkCls}>
          {totalJobs.toLocaleString()} tracked
        </button>
      </p>
    </div>
  );
}
