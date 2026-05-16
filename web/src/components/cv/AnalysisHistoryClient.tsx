"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  Clock,
  Loader2,
  XCircle,
  ArrowRight,
  Building2,
  Filter,
} from "lucide-react";

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

function fmtDate(s: string) {
  return new Date(s).toLocaleString("en-AU", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function StatusIcon({ status }: { status: HistoryRun["status"] }) {
  if (status === "completed")
    return <CheckCircle2 className="h-5 w-5 shrink-0 text-green" />;
  if (status === "running")
    return <Loader2 className="h-5 w-5 shrink-0 animate-spin text-[var(--brand)]" />;
  if (status === "failed")
    return <XCircle className="h-5 w-5 shrink-0 text-red" />;
  return <Clock className="h-5 w-5 shrink-0 text-text-3" />;
}

/**
 * Analysis history — ported from cv-magic's analysis-history-client.tsx.
 *
 * Structure matches cv-magic exactly:
 *   • space-y-6 between company sections (24px gap — bigger breathing room)
 *   • Each section: rounded-lg border bg-[var(--surface)] (8px corners)
 *   • Header: Building2 icon + serif company name + job-title pill
 *   • Body: divide-y list of run rows with status icon + match% + arrow
 */
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
      <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] p-12 text-center">
        <p className="text-sm text-text-3">
          No analyses yet. Run one from any job — click the{" "}
          <span className="rounded border border-[var(--brand)]/30 bg-[var(--brand)]/10 px-1.5 py-0.5 text-xs font-semibold text-[var(--brand)]">
            Analyze
          </span>{" "}
          button on a job row.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Status filter — cv-magic style dropdown look */}
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm">
          <Filter className="h-3.5 w-3.5 text-text-3" />
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as StatusFilter)}
            className="bg-transparent text-sm text-text outline-none cursor-pointer"
          >
            <option value="all">All ({counts.all})</option>
            <option value="completed">Completed ({counts.completed})</option>
            <option value="running">Running ({counts.running})</option>
            <option value="failed">Failed ({counts.failed})</option>
          </select>
        </label>
      </div>

      {grouped.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] p-8 text-center">
          <p className="text-sm text-text-3">No runs match this filter.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map(([jobId, runs]) => {
            const job = jobById.get(jobId);
            return (
              <section
                key={jobId}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-hidden"
              >
                <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-3">
                  <div className="min-w-0 flex items-center gap-2 flex-wrap">
                    <Building2 className="h-4 w-4 shrink-0 text-text-3" />
                    <Link
                      href={`/dashboard/jobs/${jobId}/analyze/${runs[0].id}`}
                      className="text-sm font-semibold text-text hover:text-[var(--brand)] truncate"
                    >
                      {job?.company ?? job?.title ?? "Unknown job"}
                    </Link>
                    {job?.title && job?.company && (
                      <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs text-text-3 truncate">
                        {job.title}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-text-3 shrink-0">
                    {runs.length} run{runs.length === 1 ? "" : "s"}
                  </span>
                </header>

                <ul className="divide-y divide-[var(--border)]">
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
  const score = run.match_score;

  return (
    <li>
      <Link
        href={`/dashboard/jobs/${run.job_id}/analyze/${run.id}`}
        className="flex items-center gap-3 px-5 py-3 hover:bg-[var(--surface-2)]/60 transition-colors"
      >
        <StatusIcon status={run.status} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap text-sm">
            <span className="font-medium text-text tabular-nums">
              {score != null ? `${Math.round(score)}% match` : "Analysis"}
            </span>
            <span className="text-xs text-text-3 tabular-nums">{fmtDate(run.created_at)}</span>
            {superseded && run.is_stale !== false && (
              <span className="rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-text-3">
                superseded
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-text-3 capitalize">
            {run.status}
            {run.status === "failed" && run.error_message && (
              <span className="text-text-3 ml-1 truncate" title={run.error_message}>
                — {run.error_message.slice(0, 80)}
              </span>
            )}
          </p>
        </div>

        <ArrowRight className="h-4 w-4 shrink-0 text-text-3" />
      </Link>
    </li>
  );
}
