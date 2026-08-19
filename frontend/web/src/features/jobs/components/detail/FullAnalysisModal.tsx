"use client";

/**
 * Full analysis popup — opened from the board detail pane's "Full analysis"
 * button instead of navigating to `/jobs/[id]/analyze/[run_id]`, so the
 * board (scroll position, selection, filters) never unmounts.
 *
 * Slides down from the top and fades in, same motion language as the side
 * panel (DetailSlideOver) but visually distinct — a top-down full takeover
 * rather than a right-edge supplementary panel, so it reads as "a different
 * kind of view" rather than a second side panel stacked on the first.
 *
 * Deliberately scoped to the JD/matching/tailoring *analysis* only — no
 * tailored CV, no cover letter (see AnalysisRunClient's `hideTailored`).
 * Those already have their own tabs in the board's detail pane; showing them
 * here too would be the exact redundancy the whole redesign has been
 * removing everywhere else.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";
import { AnalysisRunClient, type AnalysisRunRow } from "@/features/cv/analysis/AnalysisRunClient";
import type { BoardJob } from "../../lib/jobFilters";

interface FullAnalysisPayload {
  run: AnalysisRunRow;
  cvLabel: string | null;
  cvCharLen: number;
  cvCategorisedSkills: { technical?: string[]; soft_skills?: string[]; domain_knowledge?: string[] } | null;
}

export function FullAnalysisModal({
  job, runId, onClose,
}: {
  job: BoardJob;
  runId: string;
  onClose: () => void;
}) {
  const [entered, setEntered] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [data, setData]   = useState<FullAnalysisPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- gate the portal on client mount once; document.body doesn't exist during SSR
    setMounted(true);
  }, []);

  // Scroll-lock for as long as the popup is open — same as the side panel.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prevOverflow; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/jobs/${job.id}/analyze/${runId}`)
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `Failed (${res.status})`);
        if (!cancelled) setData(json as FullAnalysisPayload);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load this analysis");
      });
    return () => { cancelled = true; };
  }, [job.id, runId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!mounted) return null;

  return createPortal(
    <>
      <div
        aria-hidden
        onClick={onClose}
        className={`fixed inset-0 z-[60] bg-black/40 transition-opacity duration-[240ms] ${
          entered ? "opacity-100" : "opacity-0"
        }`}
      />
      {/* Outer flex frame — centres the popup horizontally, anchors it near
          the top vertically (not true vertical centring: the content is long
          and scrolls internally, so centring would just push the header off
          the top of the viewport on most screens). */}
      <div className="fixed inset-0 z-[61] flex justify-center px-4 pt-6 pb-6 sm:pt-10 pointer-events-none">
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Full analysis — ${job.title}`}
          // Demo-consistent sizing: matches the standalone analyze page's own
          // `max-w-4xl` content column, not the side panel's narrower 684px.
          className={`pointer-events-auto w-full max-w-4xl bg-surface border border-border rounded-xl shadow-2xl flex flex-col max-h-full overflow-hidden transition-all duration-[320ms] [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] will-change-transform ${
            entered ? "translate-y-0 opacity-100" : "-translate-y-8 opacity-0"
          }`}
        >
          {/* Sticky header — the close button stays reachable regardless of
              how far the analysis content scrolls, same principle as the
              side panel's own sticky head+tabs. */}
          <div className="shrink-0 sticky top-0 z-10 bg-surface border-b border-border px-6 py-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-micro font-semibold uppercase tracking-[0.08em] text-text-3">Full analysis</p>
              <h2 className="text-lead font-bold text-text mt-0.5 truncate">{job.title}</h2>
              <p className="text-label text-text-2 mt-0.5 truncate">
                {job.company}{job.location ? ` · ${job.location}` : ""}
              </p>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 text-text-3 hover:text-text p-1.5 rounded-md hover:bg-[var(--surface-2)] transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
            {error ? (
              <p className="text-label text-danger bg-danger-subtle border border-danger-border rounded px-3 py-2">{error}</p>
            ) : !data ? (
              <div className="flex items-center gap-2 py-12 justify-center text-label text-text-3">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : (
              <AnalysisRunClient
                runId={runId}
                initial={data.run}
                cvLabel={data.cvLabel}
                cvCharLen={data.cvCharLen}
                cvCategorisedSkills={data.cvCategorisedSkills}
                hideTailored
              />
            )}
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
