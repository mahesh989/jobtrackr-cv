"use client";

/**
 * Interactive KPI cards for the main dashboard.
 *
 * Replaces the old status tab bar — each card is now a navigation trigger:
 *   Total jobs     → scroll to (or pulse) the jobs board, highlight while in view
 *   New · unseen   → filter the board to unseen jobs (omitted entirely at 0)
 *   Applied        → the board's flat Applied view
 *
 * "New · unseen" is dropped from the DOM at 0 rather than rendered greyed
 * out. A permanent dead card was taking a quarter of the row to say nothing,
 * while being the most actionable card here whenever it is non-zero.
 *
 * There was a fourth card, "Auto-scheduled" (→ /profiles?autoScheduled=true).
 * It was removed: it reported profile CONFIG, not anything the user acts on
 * from this screen, and /profiles is already one click away in the sidebar.
 *
 * The jobs board is server-rendered; this client component targets it by the
 * `jobs-board` id rather than owning it.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { APPLIED_HREF } from "@/features/jobs/lib/boardViews";

const JOBS_BOARD_ID = "jobs-board";

export function StatCards({
  totalJobs,
  totalNew,
  totalApplied,
}: {
  totalJobs: number;
  totalNew: number;
  totalApplied: number;
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
      sessionStorage.setItem("lastDashboardTab", "/");
    } catch {
      /* sessionStorage unavailable — back button falls back to router.back() */
    }
  }

  function handleAppliedClick() {
    rememberOrigin();
    router.push(APPLIED_HREF);
  }

  const cardBase =
    "kpi-card cursor-pointer transition-all hover:border-[var(--brand)]/50 " +
    "focus:outline-none focus-visible:border-[var(--brand)] focus-visible:ring-1 focus-visible:ring-[var(--brand)]/30";

  const showNew = totalNew > 0;

  return (
    <div className={`grid grid-cols-2 gap-3 anim-in ${showNew ? "sm:grid-cols-3" : ""}`}>
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

      {/* New · unseen — omitted entirely at 0 (see the note at the top) */}
      {showNew && (
        <div
          role="button"
          tabIndex={0}
          onClick={handleNewClick}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && handleNewClick()}
          className={`${cardBase} border-[var(--brand)] ring-1 ring-[var(--brand)]/20`}
        >
          <div className="kpi-value text-[var(--brand)]">{totalNew}</div>
          <div className="kpi-label">New · unseen</div>
        </div>
      )}

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
    </div>
  );
}
