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
 * This side is FACTS only. "New · unseen" was also a KPI card, but it names
 * something to DO, so it lives in NextActions on the other side of the row
 * rather than being split away from the other actions.
 *
 * Every navigation path the KPI cards owned is preserved:
 *   N applied → APPLIED_HREF                    (was: Applied card)
 *   N tracked → scroll/pulse the jobs board     (was: Total jobs card)
 *   N new     → ?status=new, now in NextActions (was: New · unseen card)
 */

import { useRouter } from "next/navigation";
import { APPLIED_HREF } from "@/features/jobs/lib/boardViews";

const JOBS_BOARD_ID = "jobs-board";

export function ProgressLine({
  totalJobs,
  totalApplied,
  appliedThisWeek,
}: {
  totalJobs: number;
  totalApplied: number;
  appliedThisWeek: number;
}) {
  const router = useRouter();

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
    <p className="text-body text-text-2 shrink-0 anim-in">
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
  );
}
