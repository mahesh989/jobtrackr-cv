"use client";

/**
 * BulkAnalyzeButton — analyse many jobs from the current view in one go.
 *
 * For triage of the review buckets (Below initial / Below final / any filtered
 * set): the user opens this, the modal lists the analysable jobs with a
 * checkbox each (all checked by default — so "selected only" is just
 * unchecking), shows the credit cost, then fans out to the EXISTING
 * POST /api/jobs/[id]/analyze endpoint — 3 at a time, no backend changes.
 *
 * "Force past the initial gate" maps to the route's ?override=initial_gate,
 * which tells cv-backend to tailor even when the initial ATS is below cutoff —
 * exactly what "complete the pipeline manually" means for a below-initial job.
 *
 * Each analyse call consumes one tailored-CV credit; the footer states the
 * cost up front so a bulk run is never a surprise.
 */

import { useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Sparkles, Loader2 } from "lucide-react";

export interface AnalyzableJob {
  id:      string;
  title:   string | null;
  company: string | null;
  /** Pipeline state, used only to default the "force past gate" toggle. */
  pipelineState?: string | null;
}

const CONCURRENCY = 3;

type RowStatus = "idle" | "analysing" | "queued" | "error";

export function BulkAnalyzeButton({
  jobs,
  label,
}: {
  jobs: AnalyzableJob[];
  /** Optional override for the trigger label (e.g. the active tab name). */
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  if (jobs.length === 0) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="gh-btn text-[12px] inline-flex items-center gap-1.5 whitespace-nowrap"
        title="Analyse these jobs in bulk — reuses your normal analysis pipeline"
      >
        <Sparkles className="w-3.5 h-3.5" />
        {label ?? `Analyse ${jobs.length}`}
      </button>
      {open && (
        <BulkModal
          jobs={jobs}
          onClose={() => { setOpen(false); router.refresh(); }}
        />
      )}
    </>
  );
}

function BulkModal({ jobs, onClose }: { jobs: AnalyzableJob[]; onClose: () => void }) {
  // All checked by default — "selected only" = uncheck the ones to skip.
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(jobs.map((j) => [j.id, true])),
  );
  // Default the force toggle ON when most of the set is below the initial gate
  // (the canonical "review below-initial" flow).
  const belowInitialCount = jobs.filter((j) => j.pipelineState === "below_initial").length;
  const [force, setForce] = useState(belowInitialCount > jobs.length / 2);
  const [statuses, setStatuses] = useState<Record<string, RowStatus>>(() =>
    Object.fromEntries(jobs.map((j) => [j.id, "idle" as RowStatus])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<{ queued: number; failed: number } | null>(null);

  const selected = jobs.filter((j) => checked[j.id]);
  const selectedCount = selected.length;

  function setStatus(id: string, s: RowStatus) {
    setStatuses((prev) => ({ ...prev, [id]: s }));
  }

  async function run() {
    setRunning(true);
    setSummary(null);

    const queue = selected.filter((j) => statuses[j.id] !== "queued");
    const qs = force ? "?override=initial_gate" : "";

    let idx = 0;
    const worker = async () => {
      while (idx < queue.length) {
        const j = queue[idx++];
        setStatus(j.id, "analysing");
        try {
          const res = await fetch(`/api/jobs/${j.id}/analyze${qs}`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({}),
          });
          if (!res.ok) {
            const e = await res.json().catch(() => ({}));
            throw new Error(e.error ?? `Analyse failed (${res.status})`);
          }
          setStatus(j.id, "queued");
        } catch (err) {
          setErrors((prev) => ({ ...prev, [j.id]: err instanceof Error ? err.message : "Failed" }));
          setStatus(j.id, "error");
        }
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    setStatuses((prev) => {
      const queued = Object.values(prev).filter((s) => s === "queued").length;
      const failed = Object.values(prev).filter((s) => s === "error").length;
      setSummary({ queued, failed });
      return prev;
    });
    setRunning(false);
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-text/40 backdrop-blur-sm" onClick={() => !running && onClose()} />
      <div className="relative bg-white rounded-lg border border-[var(--border)] shadow-xl w-full max-w-xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[var(--border)]">
          <h2 className="text-[15px] font-semibold text-text">Analyse jobs in bulk</h2>
          <p className="text-[12px] text-text-2 mt-0.5 leading-snug">
            Runs your normal analysis pipeline, {CONCURRENCY} at a time. Uncheck any
            you want to skip. Each analysis uses one credit.
          </p>
        </div>

        {/* Body — job checklist */}
        <div className="px-5 py-3 overflow-y-auto flex-1 divide-y divide-[var(--border)]">
          {jobs.map((j) => {
            const status = statuses[j.id];
            return (
              <label
                key={j.id}
                className="flex items-center gap-3 py-2 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={!!checked[j.id]}
                  disabled={running || status === "queued"}
                  onChange={(e) => setChecked((prev) => ({ ...prev, [j.id]: e.target.checked }))}
                  className="w-4 h-4 rounded border-[var(--border)] accent-[var(--brand)]"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-text truncate">{j.title ?? "(untitled)"}</p>
                  {j.company && <p className="text-[11px] text-text-2 truncate">{j.company}</p>}
                </div>
                <StatusTag status={status} error={errors[j.id]} />
              </label>
            );
          })}
        </div>

        {/* Force toggle */}
        <div className="px-5 py-2.5 border-t border-[var(--border)]">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={force}
              disabled={running}
              onChange={(e) => setForce(e.target.checked)}
              className="w-4 h-4 mt-0.5 rounded border-[var(--border)] accent-[var(--brand)]"
            />
            <span className="text-[12px] text-text-2 leading-snug">
              <span className="font-medium text-text">Force past the initial gate</span> — tailor a CV
              even if the initial ATS is below your cutoff. Use this to complete below-initial jobs.
            </span>
          </label>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[var(--border)] flex items-center justify-between gap-2 bg-[var(--surface-2)] rounded-b-lg">
          <span className="text-[12px] text-text-2">
            {summary
              ? `${summary.queued} queued${summary.failed ? ` · ${summary.failed} failed` : ""}`
              : `${selectedCount} selected · ${selectedCount} credit${selectedCount !== 1 ? "s" : ""}`}
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} disabled={running} className="gh-btn text-[13px]">
              {summary ? "Close & refresh" : "Cancel"}
            </button>
            {!summary && (
              <button
                onClick={run}
                disabled={running || selectedCount === 0}
                className="gh-btn gh-btn-primary text-[13px] inline-flex items-center gap-1.5"
              >
                {running && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {running ? "Analysing…" : `Analyse ${selectedCount}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function StatusTag({ status, error }: { status: RowStatus; error?: string }) {
  const base = "text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border whitespace-nowrap shrink-0";
  if (status === "queued")    return <span className={`${base} text-emerald-700 bg-emerald-50 border-emerald-200`}>Queued ✓</span>;
  if (status === "analysing") return <span className={`${base} text-blue-700 bg-blue-50 border-blue-200`}>Analysing…</span>;
  if (status === "error")     return <span className={`${base} text-[#CF222E] bg-[#FFEBE9] border-[#CF222E]/30`} title={error}>Failed</span>;
  return null;
}
