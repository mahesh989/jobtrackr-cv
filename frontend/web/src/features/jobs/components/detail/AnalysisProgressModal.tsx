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

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Loader2, CheckCircle2, X, AlertTriangle, MinusCircle, StopCircle } from "lucide-react";
import { Button } from "@/components/ui";

/** Pipeline steps shown in this compact popup, labelled to match the full
 *  analysis page (AnalysisRunClient's STEPS) for the ones both surfaces show.
 *  Deliberately narrower than the backend's real step list: "ai_recommendations"
 *  is a real step (it always runs when the pipeline reaches this far) but skips
 *  for any job that stops at an earlier gate — which is most below-gate jobs —
 *  so it spent most of its time here reading as a permanent "— skipped" row
 *  rather than useful progress. It's still visible on the full analysis page. */
const STEPS: { key: string; label: string }[] = [
  { key: "jd_analysis",           label: "Analysing job description" },
  { key: "cv_jd_matching",        label: "Matching CV to JD" },
  { key: "ats_scoring",           label: "ATS scoring" },
  { key: "input_recommendations", label: "Building recommendations" },
  { key: "keyword_feasibility",   label: "Classifying keyword feasibility" },
  { key: "tailored_cv",           label: "Creating tailored CV" },
];

/** Never-changing subscription — this store only distinguishes server from
 *  client, so there is nothing to subscribe to. */
const subscribeNoop = () => () => {};

function StepIcon({ state }: { state: string | undefined }) {
  if (state === "completed") return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" aria-hidden />;
  if (state === "running")   return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--brand)]" aria-hidden />;
  if (state === "failed")    return <AlertTriangle className="h-4 w-4 shrink-0 text-red-600" aria-hidden />;
  if (state === "skipped")   return <MinusCircle className="h-4 w-4 shrink-0 text-text-3" aria-hidden />;
  return <span className="h-4 w-4 shrink-0 rounded-full border border-[var(--border)]" aria-hidden />;
}

export function AnalysisProgressModal({
  jobTitle, steps, phase, onDismiss, onStop, stopping = false, analysisHref = null,
}: {
  jobTitle: string;
  /** analysis_runs.step_status; null until the first Realtime event arrives. */
  steps: Record<string, string> | null;
  phase: "running" | "completed" | "failed" | "cancelled";
  onDismiss: () => void;
  /** Omitted when the run can't be cancelled (no run id yet). */
  onStop?: () => void;
  stopping?: boolean;
  /** Full analysis page for the finished run — the natural next step once the
   *  pipeline completes, so the completion card offers it directly. */
  analysisHref?: string | null;
}) {
  // Portal only after mount: `document` doesn't exist during the server render
  // of this client component, and a run that is already live when the page
  // loads makes the parent render this on the very first pass — which crashed
  // the dashboard's server render with "document is not defined". Deferring to
  // an effect also keeps the server and first client render identical, so there
  // is no hydration mismatch.
  // useSyncExternalStore is the lint-clean way to ask "am I on the client?":
  // it returns the server snapshot (false) during SSR and the client snapshot
  // (true) afterwards, with no setState-in-effect.
  const mounted = useSyncExternalStore(subscribeNoop, () => true, () => false);

  // Steps arrive only once the pipeline writes its first update, so an early
  // modal would otherwise render seven blank rows.
  const started = steps != null;
  const doneCount = started
    ? STEPS.filter((s) => steps[s.key] === "completed" || steps[s.key] === "skipped").length
    : 0;

  if (!mounted) return null;

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
          ) : phase === "cancelled" ? (
            <StopCircle className="h-10 w-10 text-text-3" aria-hidden />
          ) : (
            <AlertTriangle className="h-10 w-10 text-red-500" aria-hidden />
          )}

          <p className="mt-3 text-lead font-semibold text-text" aria-live="polite">
            {phase === "running"   ? "Analysing this job…"
             : phase === "completed" ? "Analysis complete"
             : phase === "cancelled" ? "Analysis stopped"
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

        {phase === "running" && onStop && (
          <button
            type="button"
            onClick={onStop}
            disabled={stopping}
            title="Stop this analysis — steps already finished are kept, the remaining ones won't run"
            className="mt-5 inline-flex w-full items-center justify-center gap-1.5 rounded-full border border-red-200 bg-red-50 py-2 text-body font-medium text-red-600 transition-colors hover:border-red-300 hover:bg-red-100 disabled:opacity-50"
          >
            {stopping
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <StopCircle className="h-4 w-4" />}
            {stopping ? "Stopping…" : "Stop analysis"}
          </button>
        )}

        {phase !== "running" && (
          <div className="mt-5 flex flex-col gap-2">
            {analysisHref && (
              <a
                href={analysisHref}
                className="inline-flex w-full items-center justify-center rounded-full bg-[var(--brand)] py-2 text-body font-medium text-[var(--brand-fg)] transition-opacity hover:opacity-90"
              >
                See full analysis ↗
              </a>
            )}
            <Button
              variant="default"
              size="sm"
              type="button"
              onClick={onDismiss}
              className="w-full rounded-full py-2 text-body font-medium"
            >
              Close
            </Button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
