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

function statusDot(s: HistoryRun["status"]) {
  switch (s) {
    case "completed": return { cls: "bg-green",            label: "Completed" };
    case "running":   return { cls: "bg-blue animate-pulse", label: "Running" };
    case "failed":    return { cls: "bg-red",              label: "Failed" };
    default:          return { cls: "bg-text-3/30",        label: "Pending" };
  }
}

function fmtDate(s: string) {
  return new Date(s).toLocaleString("en-AU", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
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
    <div className="space-y-5 max-w-4xl">
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
                <header className="flex items-start justify-between gap-3 border-b border-border bg-surface-2 px-5 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link
                        href={`/dashboard/jobs/${jobId}/analyze/${runs[0].id}`}
                        className="text-[13px] font-semibold text-text hover:text-[#0969DA] truncate"
                      >
                        {job?.title ?? "Unknown job"}
                      </Link>
                      {job?.company && (
                        <span className="text-[11px] text-text-3">· {job.company}</span>
                      )}
                    </div>
                    <p className="text-[11px] text-text-3 mt-0.5">
                      {job?.location ?? ""}
                      {job?.url && (
                        <>
                          {" "}
                          <a href={job.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                            · Listing ↗
                          </a>
                        </>
                      )}
                    </p>
                  </div>
                  <span className="text-[10px] text-text-3 shrink-0">
                    {runs.length} run{runs.length === 1 ? "" : "s"}
                  </span>
                </header>

                <ul className="divide-y divide-border">
                  {runs.map((r) => <RunRow key={r.id} run={r} />)}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RunRow({ run }: { run: HistoryRun }) {
  const dot = statusDot(run.status);
  const lift = run.ats_lift;
  return (
    <li>
      <Link
        href={`/dashboard/jobs/${run.job_id}/analyze/${run.id}`}
        className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2/60"
      >
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dot.cls}`} title={dot.label} />

        {/* Score block */}
        <div className="w-32 shrink-0">
          {run.match_score != null ? (
            <div className="flex items-baseline gap-1.5">
              <span className="text-[13px] font-semibold text-text tabular-nums">
                {Math.round(run.match_score)}
              </span>
              <span className="text-[10px] text-text-3">→</span>
              <span className="text-[13px] font-semibold text-text tabular-nums">
                {run.tailored_match_score != null ? Math.round(run.tailored_match_score) : "—"}
              </span>
              {typeof lift === "number" && (
                <span className={`text-[10px] tabular-nums ${lift >= 0 ? "text-green" : "text-red"}`}>
                  {lift > 0 ? "+" : ""}{lift}
                </span>
              )}
            </div>
          ) : (
            <span className="text-[12px] text-text-3 italic">{dot.label}…</span>
          )}
        </div>

        {/* Timestamp + flags */}
        <div className="flex-1 min-w-0">
          <p className="text-[12px] text-text-2 tabular-nums">{fmtDate(run.created_at)}</p>
          <div className="flex items-center gap-1.5 mt-0.5">
            {run.is_stale && (
              <span className="text-[10px] text-text-3 bg-surface-2 border border-border rounded px-1.5 py-0.5">
                Stale
              </span>
            )}
            {run.status === "failed" && run.error_message && (
              <span className="text-[10px] text-red truncate max-w-[28rem]" title={run.error_message}>
                {run.error_message}
              </span>
            )}
          </div>
        </div>

        <span className="text-text-3 text-[12px]">→</span>
      </Link>
    </li>
  );
}
