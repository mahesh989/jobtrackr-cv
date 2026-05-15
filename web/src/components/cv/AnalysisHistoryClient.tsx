"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

export interface HistoryRun {
  id:                   string;
  job_id:               string;
  status:               "pending" | "running" | "completed" | "failed";
  match_score:          number | null;
  tailored_match_score: number | null;
  ats_lift:             number | null;
  is_stale:             boolean;
  error_message:        string | null;
  created_at:           string;
  completed_at:         string | null;
}

export interface HistoryJob {
  id:        string;
  title:     string;
  company:   string | null;
  location:  string | null;
  source:    string | null;
  url:       string | null;
}

type StatusFilter = "all" | "completed" | "running" | "failed";

interface Props {
  initialRuns: HistoryRun[];
  jobs:        HistoryJob[];
}

function statusInfo(s: HistoryRun["status"]) {
  switch (s) {
    case "completed": return { label: "Completed", cls: "text-green"   };
    case "running":   return { label: "Running",   cls: "text-[#0969DA]" };
    case "failed":    return { label: "Failed",    cls: "text-red"     };
    default:          return { label: "Pending",   cls: "text-text-3"  };
  }
}

function fmtDate(s: string) {
  return new Date(s).toLocaleString("en-AU", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function StatusIcon({ status }: { status: HistoryRun["status"] }) {
  if (status === "completed") {
    return (
      <svg className="w-5 h-5 text-green shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg className="w-5 h-5 text-red shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <path d="M15 9l-6 6M9 9l6 6" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "running") {
    return (
      <svg className="w-5 h-5 text-[#0969DA] shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 12a9 9 0 11-6.219-8.56" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg className="w-5 h-5 text-text-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function AnalysisHistoryClient({ initialRuns, jobs }: Props) {
  const [filter, setFilter] = useState<StatusFilter>("all");

  const jobById = useMemo(() => {
    const m = new Map<string, HistoryJob>();
    for (const j of jobs) m.set(j.id, j);
    return m;
  }, [jobs]);

  const filtered = useMemo(() => {
    if (filter === "all") return initialRuns;
    return initialRuns.filter((r) => r.status === filter);
  }, [initialRuns, filter]);

  // Group by job_id; preserve newest-first across groups by their latest run
  const grouped = useMemo(() => {
    const groups = new Map<string, HistoryRun[]>();
    for (const r of filtered) {
      if (!groups.has(r.job_id)) groups.set(r.job_id, []);
      groups.get(r.job_id)!.push(r);
    }
    return Array.from(groups.entries()).sort(
      (a, b) => (b[1][0]?.created_at ?? "").localeCompare(a[1][0]?.created_at ?? ""),
    );
  }, [filtered]);

  const counts = useMemo(() => {
    const c = { all: initialRuns.length, completed: 0, running: 0, failed: 0 } as Record<StatusFilter, number>;
    for (const r of initialRuns) {
      if (r.status === "completed" || r.status === "running" || r.status === "failed") c[r.status]++;
    }
    return c;
  }, [initialRuns]);

  if (initialRuns.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-surface px-6 py-12 text-center">
        <p className="text-[13px] text-text-3">
          No analyses yet. Run one from any job — click the{" "}
          <span className="px-1.5 py-0.5 text-[11px] text-[#0969DA] border border-[#0969DA]/30 rounded">Analyze</span>{" "}
          button on a job row.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-4xl mx-auto">
      {/* Status filter */}
      <div className="flex flex-wrap gap-1">
        {(["all", "completed", "running", "failed"] as StatusFilter[]).map((s) => {
          const active = filter === s;
          return (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`text-[12px] px-2.5 py-1 rounded border ${
                active
                  ? "bg-[#DDF4FF] border-[#0969DA]/30 text-[#0969DA]"
                  : "bg-surface border-border text-text-2 hover:border-text-3"
              }`}
            >
              {s[0].toUpperCase() + s.slice(1)}{" "}
              <span className="text-text-3 tabular-nums">({counts[s]})</span>
            </button>
          );
        })}
      </div>

      {grouped.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-surface px-6 py-8 text-center">
          <p className="text-[12px] text-text-3">No runs match this filter.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map(([jobId, runs]) => {
            const job = jobById.get(jobId);
            return (
              <section key={jobId} className="bg-surface border border-border rounded-md overflow-hidden">
                <header className="flex items-center justify-between gap-3 border-b border-border bg-surface-2 px-5 py-3">
                  <div className="min-w-0 flex items-center gap-2 flex-wrap">
                    <svg className="w-4 h-4 text-text-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1m0 4h1m4-4h1m-1 4h1m-6 4h6"/>
                    </svg>
                    <Link
                      href={`/dashboard/jobs/${jobId}/analyze/${runs[0].id}`}
                      className="text-[14px] font-semibold text-text hover:text-[#0969DA] truncate"
                    >
                      {job?.company ?? job?.title ?? "Unknown job"}
                    </Link>
                    {job?.title && job?.company && (
                      <span className="text-[10px] uppercase tracking-wider text-text-3 bg-surface border border-border rounded-full px-2 py-0.5">
                        {job.title}
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-text-3 shrink-0">
                    {runs.length} run{runs.length === 1 ? "" : "s"}
                  </span>
                </header>

                <ul className="divide-y divide-border">
                  {runs.map((r, i) => <RunRow key={r.id} run={r} superseded={i > 0} />)}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RunRow({ run, superseded }: { run: HistoryRun; superseded: boolean }) {
  const info = statusInfo(run.status);
  // cv-magic uses the SINGLE score (match_score, the original CV's ATS score
  // against this JD) for the "X% match" label, not the post-tailoring score.
  const score = run.match_score;

  return (
    <li>
      <Link
        href={`/dashboard/jobs/${run.job_id}/analyze/${run.id}`}
        className="flex items-center gap-4 px-5 py-3 hover:bg-surface-2/60"
      >
        <StatusIcon status={run.status} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[14px] font-semibold text-text tabular-nums">
              {score != null ? `${Math.round(score)}% match` : "Analysis"}
            </span>
            <span className="text-[12px] text-text-3 tabular-nums">{fmtDate(run.created_at)}</span>
            {superseded && run.is_stale !== false && (
              <span className="text-[10px] uppercase tracking-wider font-bold text-text-3 bg-surface-2 border border-border rounded px-1.5 py-0.5">
                SUPERSEDED
              </span>
            )}
          </div>
          <p className={`text-[12px] mt-0.5 ${info.cls}`}>
            {info.label}
            {run.status === "failed" && run.error_message && (
              <span className="text-text-3 ml-2 truncate" title={run.error_message}>
                · {run.error_message}
              </span>
            )}
          </p>
        </div>

        <svg className="w-4 h-4 text-text-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
        </svg>
      </Link>
    </li>
  );
}
