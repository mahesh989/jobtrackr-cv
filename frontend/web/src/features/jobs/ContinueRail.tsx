"use client";

/**
 * "Continue where you left off" — 3 horizontal cards above the job
 * board showing the most recently progressed jobs. Each card has a
 * 4-dot progress indicator and a contextual "next action" CTA.
 * Dismissable per browser via localStorage.
 *
 * Hidden when:
 *   - dismissed (localStorage key jobtrackr-rail-dismissed = "1")
 *   - no jobs have any progress yet
 *   - user is not on the Active tab (unless showRailOnAllTabs is on)
 *   - settings.hideRail is true
 */

import { useState, useEffect } from "react";
import Link from "next/link";
import { Bookmark, X } from "lucide-react";
import { Button } from "@/ui";
import type { JobProgress } from "./progressFlags";
import { nextAction } from "./progressFlags";

export interface RailJob {
  id:                string;
  profile_id:        string;
  title:             string;
  company:           string;
  progress:          JobProgress;
}

const DISMISS_KEY = "jobtrackr-rail-dismissed";

function ProgressDots({ p }: { p: JobProgress }) {
  const cells: Array<{ on: boolean; label: string }> = [
    { on: p.has_analysis,     label: "Analysed"  },
    { on: p.has_tailored_cv,  label: "Tailored CV" },
    { on: p.has_cover_letter, label: "Cover letter" },
    { on: p.is_applied,       label: "Applied"   },
  ];
  return (
    <div className="flex items-center gap-1">
      {cells.map((c, i) => (
        <span
          key={i}
          title={c.on ? `${c.label} ✓` : c.label}
          className={`inline-block w-2 h-2 rounded-full transition-colors ${
            c.on ? "bg-[var(--brand)]" : "bg-[var(--border)]"
          }`}
        />
      ))}
    </div>
  );
}

export function ContinueRail({ jobs, currentTab }: { jobs: RailJob[]; currentTab: string }) {
  const [dismissed, setDismissed]   = useState<boolean | null>(null); // null = SSR/loading

  useEffect(() => {
    // Mount-only read of an external system (localStorage), deferred past
    // hydration on purpose — server always renders null (SSR/loading);
    // reading synchronously during the first client render risks a
    // hydration mismatch. No "previous render" to compare against.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR-safe hydration read, not a sync loop
    setDismissed(typeof window !== "undefined" && window.localStorage.getItem(DISMISS_KEY) === "1");
  }, []);

  if (dismissed === null) return null;     // avoid SSR flash
  if (dismissed)          return null;
  if (jobs.length === 0)  return null;
  const isActiveTab = currentTab === "all" || !currentTab;
  if (!isActiveTab)       return null;

  function dismiss() {
    try { window.localStorage.setItem(DISMISS_KEY, "1"); } catch { /* quota */ }
    setDismissed(true);
  }

  return (
    <div className="bg-surface border border-border rounded-md p-3 anim-in">
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <div className="flex items-center gap-1.5">
          <Bookmark className="w-3.5 h-3.5 text-[var(--brand)]" />
          <span className="text-[12px] font-semibold text-text">Continue where you left off</span>
          <span className="text-[10px] text-text-3 ml-1">({jobs.length})</span>
        </div>
        <Button
          onClick={dismiss}
          title="Hide this rail"
          className="inline-flex items-center justify-center w-6 h-6 rounded text-text-3 hover:text-text hover:bg-[var(--surface-2)] transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        {jobs.map((job) => {
          const action = nextAction(job, job.progress);
          return (
            <div
              key={job.id}
              className="border border-[var(--border)] rounded-md bg-[var(--surface-2)] p-2.5 flex flex-col gap-1.5 hover:border-[var(--text-3)] transition-colors"
            >
              <div className="min-w-0">
                <p className="text-[12px] font-semibold text-text truncate" title={job.title}>
                  {job.title}
                </p>
                <p className="text-[11px] text-text-2 truncate" title={job.company}>
                  {job.company || "—"}
                </p>
              </div>
              <div className="flex items-center justify-between gap-2 mt-0.5">
                <ProgressDots p={job.progress} />
                {action.href ? (
                  <Link
                    href={action.href}
                    className="text-[11px] font-medium text-[var(--brand)] hover:underline whitespace-nowrap"
                  >
                    {action.label} →
                  </Link>
                ) : (
                  <span className="text-[11px] font-medium text-text-3 italic whitespace-nowrap">
                    {action.label}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
