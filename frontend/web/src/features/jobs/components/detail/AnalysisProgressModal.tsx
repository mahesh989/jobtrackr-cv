"use client";

/**
 * Analysis progress popup — the "where is it up to?" surface for a running
 * analysis, modelled on the CV-upload modal (LibraryModals.UploadProgressModal).
 *
 * Why this exists: the detail header only rendered "Analysing…" on its
 * "Analyse this job" / "Retry analysis" buttons, and neither of those is on
 * screen for a job that has already been analysed — that branch renders
 * "Apply now" instead. Re-analysing from the ⋯ menu therefore changed nothing
 * visible, even though the run was live. This shows the run wherever it was
 * started from.
 *
 * Closing is safe: the run state lives in the analysis_runs row (see
 * useJobRunStatus), not in this component, so dismissing loses nothing and the
 * header's "Analysing…" chip reopens it.
 */

import { createPortal } from "react-dom";
import { Loader2, CheckCircle2, X, AlertTriangle, MinusCircle } from "lucide-react";
import { Button } from "@/components/ui";

/** Pipeline steps in execution order, labelled to match the full analysis page
 *  (AnalysisRunClient's STEPS) so the two surfaces don't drift apart. */
const STEPS: { key: string; label: string }[] = [
  { key: "jd_analysis",           label: "Analysing job description" },
  { key: "cv_jd_matching",        label: "Matching CV to JD" },
  { key: "ats_scoring",           label: "ATS scoring" },
  { key: "input_recommendations", label: "Building recommendations" },
  { key: "keyword_feasibility",   label: "Classifying keyword feasibility" },
  { key: "ai_recommendations",    label: "Generating AI advice" },
  { key: "tailored_cv",           label: "Creating tailored CV" },
];

function StepIcon({ state }: { state: string | undefined }) {
  if (state === "completed") return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" aria-hidden />;
  if (state === "running")   return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--brand)]" aria-hidden />;
  if (state === "failed")    return <AlertTriangle className="h-4 w-4 shrink-0 text-red-600" aria-hidden />;
  if (state === "skipped")   return <MinusCircle className="h-4 w-4 shrink-0 text-text-3" aria-hidden />;
  return <span className="h-4 w-4 shrink-0 rounded-full border border-[var(--border)]" aria-hidden />;
}

export function AnalysisProgressModal({
  jobTitle, steps, phase, onDismiss,
}: {
  jobTitle: string;
  /** analysis_runs.step_status; null until the first Realtime event arrives. */
  steps: Record<string, string> | null;
  phase: "running" | "completed" | "failed";
  onDismiss: () => void;
}) {
  // Steps arrive only once the pipeline writes its first update, so an early
  // modal would otherwise render seven blank rows.
  const started = steps != null;
  const doneCount = started
    ? STEPS.filter((s) => steps[s.key] === "completed" || steps[s.key] === "skipped").length
    : 0;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-text/40 backdrop-blur-sm" onClick={onDismiss} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Analysis progress"
        className="relative w-full max-w-md rounded-2xl border border-[var(--border)] bg-surface p-6 shadow-xl"
      >
        <Button
          variant="default"
          size="sm"
          type="button"
          onClick={onDismiss}
          aria-label="Close"
          className="absolute right-3 top-3 rounded-full p-1.5"
        >
          <X className="h-4 w-4" />
        </Button>

        <div className="flex flex-col items-center text-center pt-3">
          {phase === "running" ? (
            <Loader2 className="h-10 w-10 animate-spin text-[var(--brand)]" aria-hidden />
          ) : phase === "completed" ? (
            <CheckCircle2 className="h-10 w-10 text-green-500" aria-hidden />
          ) : (
            <AlertTriangle className="h-10 w-10 text-red-500" aria-hidden />
          )}

          <p className="mt-3 text-lead font-semibold text-text" aria-live="polite">
            {phase === "running"   ? "Analysing this job…"
             : phase === "completed" ? "Analysis complete"
             :                         "Analysis failed"}
          </p>
          <p className="mt-1 text-body text-text-2 line-clamp-2">{jobTitle}</p>
          {phase === "running" && (
            <p className="mt-1 text-caption text-text-3">
              {started ? `${doneCount} of ${STEPS.length} steps done` : "Starting…"}
              {" · you can close this and keep working"}
            </p>
          )}
        </div>

        <ol className="mt-5 space-y-2 text-left">
          {STEPS.map((s) => {
            const state = started ? steps[s.key] : undefined;
            const dim = state == null || state === "pending";
            return (
              <li key={s.key} className="flex items-center gap-2.5">
                <StepIcon state={state} />
                <span className={`text-label ${dim ? "text-text-3" : "text-text"}`}>
                  {s.label}
                </span>
                {state === "skipped" && (
                  <span className="text-caption text-text-3">— skipped</span>
                )}
              </li>
            );
          })}
        </ol>

        {phase !== "running" && (
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={onDismiss}
            className="mt-5 w-full rounded-full py-2 text-body font-medium"
          >
            OK
          </Button>
        )}
      </div>
    </div>,
    document.body,
  );
}
