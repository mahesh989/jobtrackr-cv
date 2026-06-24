"use client";

/**
 * BulkThinJdButton — fix several thin-JD jobs in one place.
 *
 * Thin-JD jobs can't be analysed until a full job description is supplied.
 * This opens a modal listing those jobs, lets the user paste the full JD for
 * each (each JD is unique, so it's per-job), then saves every JD and queues
 * analysis for the ones that are now long enough — 3 at a time to stay gentle
 * on the user's AI key. Reuses PATCH /api/jobs/[id] + POST /api/jobs/[id]/analyze;
 * no backend changes.
 */

import { useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { FileText } from "lucide-react";

export interface ThinJdJob {
  id:             string;
  title:          string | null;
  company:        string | null;
  description:    string | null;
  manual_jd_text: string | null;
}

const MIN_CHARS   = 200;
const CONCURRENCY = 3;

type RowStatus = "idle" | "saving" | "analysing" | "queued" | "error";

function BulkThinJdButton({ jobs }: { jobs: ThinJdJob[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  if (jobs.length === 0) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="gh-btn text-[12px] inline-flex items-center gap-1.5 whitespace-nowrap"
        title="Paste full job descriptions and analyse thin-JD jobs in bulk"
      >
        <FileText className="w-3.5 h-3.5" />
        Fix thin JDs ({jobs.length})
      </button>
      {open && <BulkModal jobs={jobs} onClose={() => { setOpen(false); router.refresh(); }} />}
    </>
  );
}

function BulkModal({ jobs, onClose }: { jobs: ThinJdJob[]; onClose: () => void }) {
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(jobs.map((j) => [j.id, j.manual_jd_text ?? j.description ?? ""])),
  );
  const [statuses, setStatuses] = useState<Record<string, RowStatus>>(() =>
    Object.fromEntries(jobs.map((j) => [j.id, "idle" as RowStatus])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<{ queued: number; failed: number } | null>(null);

  const readyCount = jobs.filter(
    (j) => statuses[j.id] !== "queued" && texts[j.id].trim().length >= MIN_CHARS,
  ).length;

  function setStatus(id: string, s: RowStatus) {
    setStatuses((prev) => ({ ...prev, [id]: s }));
  }

  async function run() {
    setRunning(true);
    setSummary(null);

    const ready = jobs.filter(
      (j) => statuses[j.id] !== "queued" && texts[j.id].trim().length >= MIN_CHARS,
    );

    let idx = 0;
    const worker = async () => {
      while (idx < ready.length) {
        const j = ready[idx++];
        setStatus(j.id, "saving");
        try {
          const patch = await fetch(`/api/jobs/${j.id}`, {
            method:  "PATCH",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ manual_jd_text: texts[j.id].trim() }),
          });
          if (!patch.ok) {
            const e = await patch.json().catch(() => ({}));
            throw new Error(e.error ?? `Save failed (${patch.status})`);
          }

          setStatus(j.id, "analysing");
          const an = await fetch(`/api/jobs/${j.id}/analyze`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({}),
          });
          if (!an.ok) {
            const e = await an.json().catch(() => ({}));
            throw new Error(e.error ?? `Analyse failed (${an.status})`);
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
      <div className="relative bg-surface rounded-lg border border-[var(--border)] shadow-xl w-full max-w-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[var(--border)]">
          <h2 className="text-[15px] font-semibold text-text">Fix thin job descriptions</h2>
          <p className="text-[12px] text-text-2 mt-0.5 leading-snug">
            Paste the full job description for each role, then analyse them together.
            We queue {CONCURRENCY} at a time. Jobs under {MIN_CHARS} characters are skipped.
          </p>
        </div>

        {/* Body */}
        <div className="px-5 py-4 overflow-y-auto space-y-4 flex-1">
          {jobs.map((j) => {
            const len    = texts[j.id].trim().length;
            const ready  = len >= MIN_CHARS;
            const status = statuses[j.id];
            return (
              <div key={j.id} className="border border-[var(--border)] rounded-md p-3">
                <div className="flex items-center justify-between gap-3 mb-1.5">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-text truncate">{j.title ?? "(untitled)"}</p>
                    {j.company && <p className="text-[11px] text-text-2 truncate">{j.company}</p>}
                  </div>
                  <StatusTag status={status} ready={ready} error={errors[j.id]} />
                </div>
                <textarea
                  value={texts[j.id]}
                  onChange={(e) => setTexts((prev) => ({ ...prev, [j.id]: e.target.value }))}
                  disabled={running || status === "queued"}
                  rows={5}
                  spellCheck={false}
                  placeholder="Paste the full job description here…"
                  className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-md px-3 py-2 text-[12px] text-text leading-relaxed font-mono focus:outline-none focus:ring-2 focus:ring-[var(--brand)]/30 resize-y disabled:opacity-60"
                />
                <div className="flex items-center justify-between mt-1">
                  <span className={`text-[11px] tabular-nums ${ready ? "text-emerald-700" : "text-text-3"}`}>
                    {len.toLocaleString()} / {MIN_CHARS} chars{ready ? " · ready" : " · too short"}
                  </span>
                  {errors[j.id] && status === "error" && (
                    <span className="text-[11px] text-[#CF222E] truncate ml-3">{errors[j.id]}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[var(--border)] flex items-center justify-between gap-2 bg-[var(--surface-2)] rounded-b-lg">
          <span className="text-[12px] text-text-2">
            {summary
              ? `${summary.queued} queued${summary.failed ? ` · ${summary.failed} failed` : ""}`
              : `${readyCount} ready to analyse`}
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} disabled={running} className="gh-btn text-[13px]">
              {summary ? "Close & refresh" : "Cancel"}
            </button>
            {!summary && (
              <button
                onClick={run}
                disabled={running || readyCount === 0}
                className="gh-btn gh-btn-primary text-[13px]"
              >
                {running ? "Working…" : `Save & analyse ready (${readyCount})`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function StatusTag({ status, ready, error }: { status: RowStatus; ready: boolean; error?: string }) {
  const base = "text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border whitespace-nowrap shrink-0";
  if (status === "queued")    return <span className={`${base} text-emerald-700 bg-emerald-50 border-emerald-200`}>Queued ✓</span>;
  if (status === "saving")    return <span className={`${base} text-blue-700 bg-blue-50 border-blue-200`}>Saving…</span>;
  if (status === "analysing") return <span className={`${base} text-blue-700 bg-blue-50 border-blue-200`}>Analysing…</span>;
  if (status === "error")     return <span className={`${base} text-[#CF222E] bg-[#FFEBE9] border-[#CF222E]/30`} title={error}>Failed</span>;
  if (ready)                  return <span className={`${base} text-emerald-700 bg-emerald-50 border-emerald-200`}>Ready</span>;
  return <span className={`${base} text-amber-700 bg-amber-50 border-amber-200`}>Too short</span>;
}
