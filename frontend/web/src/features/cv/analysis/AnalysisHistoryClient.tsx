"use client";

import { useMemo, useState } from "react";
import { HoverPrefetchLink } from "@/components/ui";
import {
  CheckCircle2,
  Clock,
  Loader2,
  XCircle,
  ChevronRight,
  Filter,
} from "lucide-react";
import { formatDateTime as fmtDate } from "@/lib/dates";
import type { RunStatus } from "@/lib/constants";

export interface HistoryRun {
  id:                   string;
  job_id:               string;
  status:               RunStatus;
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

function StatusIcon({ status }: { status: HistoryRun["status"] }) {
  if (status === "completed")
    return <CheckCircle2 className="h-4 w-4 shrink-0 text-green" />;
  if (status === "running")
    return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--brand)]" />;
  if (status === "failed")
    return <XCircle className="h-4 w-4 shrink-0 text-red" />;
  return <Clock className="h-4 w-4 shrink-0 text-text-3" />;
}

interface HistoryRowData {
  run:       HistoryRun;
  job:       HistoryJob | undefined;
  groupSize: number;
  isFirst:   boolean;
}

/**
 * Analysis history — dense grid-table, matching ProfilesTable's pattern
 * (uppercase caption header row + flat grid rows) instead of a bordered
 * card per job. At 100+ runs the old per-job-section layout (own border,
 * header, divide-y list) cost ~90-100px per row for the common single-run
 * case; this is one table, ~48px/row, same info.
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

  const rows = useMemo(() => {
    const groups = new Map<string, HistoryRun[]>();
    for (const r of filtered) {
      if (!groups.has(r.job_id)) groups.set(r.job_id, []);
      groups.get(r.job_id)!.push(r);
    }
    const ordered = Array.from(groups.entries()).sort(
      (a, b) => (b[1][0]?.created_at ?? "").localeCompare(a[1][0]?.created_at ?? ""),
    );
    return ordered.flatMap(([jobId, runs]) =>
      runs.map((run, i): HistoryRowData => ({
        run, job: jobById.get(jobId), groupSize: runs.length, isFirst: i === 0,
      })),
    );
  }, [filtered, jobById]);

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

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] p-8 text-center">
          <p className="text-sm text-text-3">No runs match this filter.</p>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-md overflow-hidden">
          <div className="overflow-x-auto">
          <div className="min-w-[720px]">
          <div className="grid grid-cols-12 gap-2 px-4 py-2.5 bg-surface-2 border-b border-border text-caption font-semibold text-text-2 uppercase tracking-wider">
            <div className="col-span-5">Job</div>
            <div className="col-span-2">Score</div>
            <div className="col-span-2">Date</div>
            <div className="col-span-3">Status</div>
          </div>
          {rows.map((row) => <RunRow key={row.run.id} row={row} />)}
          </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RunRow({ row }: { row: HistoryRowData }) {
  const { run, job, groupSize, isFirst } = row;
  // Show the final tailored score if available, otherwise the initial score
  const finalScore = run.tailored_match_score ?? run.match_score;
  const isTailored = run.tailored_match_score != null;
  const scoreLabel = finalScore != null ? `${Math.round(finalScore)}%` : "—";
  const superseded = !isFirst && run.is_stale !== false;

  return (
    <HoverPrefetchLink
      href={`/jobs/${run.job_id}/analyze/${run.id}`}
      className="grid grid-cols-12 gap-2 items-center px-4 py-2.5 border-b border-border last:border-0 hover:bg-surface-2 transition-colors"
    >
      <div className="col-span-5 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-body font-semibold text-text truncate">
            {job?.title ?? "Unknown job"}
          </span>
          {isFirst && groupSize > 1 && (
            <span className="shrink-0 rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-micro font-bold text-text-3">
              {groupSize} runs
            </span>
          )}
          {superseded && (
            <span className="shrink-0 rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-micro font-bold uppercase tracking-wide text-text-3">
              superseded
            </span>
          )}
        </div>
        <p className="text-caption text-text-2 truncate">
          {job?.company ?? "—"}{job?.location ? ` · ${job.location}` : ""}
        </p>
      </div>

      <div className="col-span-2 min-w-0">
        <span className="text-body font-medium text-text tabular-nums">{scoreLabel}</span>
        {isTailored && run.match_score != null && (
          <p className="text-caption text-text-3 tabular-nums">
            initial {Math.round(run.match_score)}%
          </p>
        )}
      </div>

      <div className="col-span-2 min-w-0">
        <span className="text-label text-text-2 tabular-nums truncate block">{fmtDate(run.created_at)}</span>
      </div>

      <div className="col-span-3 flex items-center gap-1.5 min-w-0">
        <StatusIcon status={run.status} />
        <span
          className="text-label text-text-2 capitalize truncate"
          title={run.status === "failed" ? run.error_message ?? undefined : undefined}
        >
          {run.status}
          {run.status === "failed" && run.error_message ? ` — ${run.error_message.slice(0, 60)}` : ""}
        </span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-3 ml-auto" />
      </div>
    </HoverPrefetchLink>
  );
}
