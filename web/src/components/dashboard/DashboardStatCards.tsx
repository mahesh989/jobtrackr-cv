"use client";

/**
 * Interactive KPI cards for the main dashboard.
 *
 * Replaces the old status tab bar — each card is now a navigation trigger:
 *   Total jobs     → scroll to (or pulse) the jobs board, highlight while in view
 *   New · unseen   → filter the board to unseen jobs (inactive when count is 0)
 *   Applied        → /dashboard/applications
 *   Auto-scheduled → /dashboard/profiles?autoScheduled=true
 *
 * The jobs board is server-rendered; this client component targets it by the
 * `jobs-board` id rather than owning it.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

const JOBS_BOARD_ID = "jobs-board";

export function DashboardStatCards({
  totalJobs,
  totalNew,
  totalApplied,
  activeCount,
}: {
  totalJobs: number;
  totalNew: number;
  totalApplied: number;
  activeCount: number;
}) {
  const router = useRouter();
  const sp = useSearchParams();

  // Pink/primary highlight on the Total card while the jobs board is in view,
  // but only once the user has activated it by clicking the card.
  const [totalActive, setTotalActive] = useState(false);
  const [jobsInFocus, setJobsInFocus] = useState(false);

  useEffect(() => {
    const el = document.getElementById(JOBS_BOARD_ID);
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        setJobsInFocus(entry.isIntersecting);
        if (!entry.isIntersecting) setTotalActive(false);
      },
      { threshold: 0.15 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  function handleTotalClick() {
    const el = document.getElementById(JOBS_BOARD_ID);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const alreadyInView = rect.top >= 0 && rect.top < window.innerHeight * 0.5;
    if (alreadyInView) {
      // Already visible — pulse it instead of scrolling.
      el.classList.remove("pulse-highlight");
      void el.offsetWidth; // force reflow so the animation can restart
      el.classList.add("pulse-highlight");
      window.setTimeout(() => el.classList.remove("pulse-highlight"), 1000);
    } else {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    setTotalActive(true);
  }

  function handleNewClick() {
    if (totalNew === 0) return;
    const params = new URLSearchParams(sp.toString());
    params.set("status", "new");
    router.push(`/dashboard?${params.toString()}`);
  }

  function rememberOrigin() {
    try {
      sessionStorage.setItem("lastDashboardTab", "/dashboard");
    } catch {
      /* sessionStorage unavailable — back button falls back to router.back() */
    }
  }

  function handleAppliedClick() {
    rememberOrigin();
    router.push("/dashboard/applications");
  }

  function handleAutoScheduledClick() {
    rememberOrigin();
    router.push("/dashboard/profiles?autoScheduled=true");
  }

  const cardBase =
    "kpi-card cursor-pointer transition-all hover:border-[var(--brand)]/50 " +
    "focus:outline-none focus-visible:border-[var(--brand)] focus-visible:ring-1 focus-visible:ring-[var(--brand)]/30";

  const newDisabled = totalNew === 0;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 anim-in">
      {/* Total jobs — scroll to / pulse the jobs board */}
      <div
        role="button"
        tabIndex={0}
        onClick={handleTotalClick}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && handleTotalClick()}
        className={`${cardBase} ${
          totalActive && jobsInFocus
            ? "border-[var(--brand)] ring-1 ring-[var(--brand)]/30"
            : ""
        }`}
      >
        <div className="kpi-value">{totalJobs.toLocaleString()}</div>
        <div className="kpi-label">Total jobs</div>
      </div>

      {/* New · unseen — filter the board, or inactive when count is 0 */}
      <div
        role={newDisabled ? undefined : "button"}
        tabIndex={newDisabled ? undefined : 0}
        onClick={newDisabled ? undefined : handleNewClick}
        onKeyDown={
          newDisabled
            ? undefined
            : (e) => (e.key === "Enter" || e.key === " ") && handleNewClick()
        }
        className={
          newDisabled
            ? "kpi-card opacity-50 pointer-events-none select-none"
            : `${cardBase} border-[var(--brand)] ring-1 ring-[var(--brand)]/20`
        }
      >
        <div className={`kpi-value ${newDisabled ? "" : "text-[var(--brand)]"}`}>{totalNew}</div>
        <div className="kpi-label">New · unseen</div>
      </div>

      {/* Applied — go to the applications outbox */}
      <div
        role="button"
        tabIndex={0}
        onClick={handleAppliedClick}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && handleAppliedClick()}
        className={`${cardBase} ${totalApplied > 0 ? "border-[#1A7F37]/40" : ""}`}
      >
        <div className={`kpi-value ${totalApplied > 0 ? "text-[#1A7F37]" : ""}`}>{totalApplied}</div>
        <div className="kpi-label">Applied</div>
      </div>

      {/* Auto-scheduled — go to profiles filtered to auto-schedule */}
      <div
        role="button"
        tabIndex={0}
        onClick={handleAutoScheduledClick}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && handleAutoScheduledClick()}
        className={cardBase}
      >
        <div className="kpi-value">{activeCount}</div>
        <div className="kpi-label">Auto-scheduled</div>
      </div>
    </div>
  );
}
