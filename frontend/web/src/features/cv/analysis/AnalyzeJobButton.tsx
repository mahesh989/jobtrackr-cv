"use client";

import { useState, useTransition, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { Sparkles, Loader2, Zap, AlertTriangle, X } from "lucide-react";

interface Props {
  jobId: string;
  /** When true, shows "Re-analyze" instead of "Analyze". */
  hasAnalysis?: boolean;
  /** If provided, overrides the standard analyze button with a "Full Analysis" link. */
  analysisHref?: string;
  /**
   * Phase C-3 override flag forwarded as ?override=… on the POST.
   *   thin_jd      — bypass the API thin-JD pre-check
   *   initial_gate — force tailoring even on low initial ATS
   *   all          — both
   */
  override?: "thin_jd" | "initial_gate" | "all";
  /** Compact mode — small "Force →" link instead of the full primary button. */
  compact?: boolean;
}

type OverrideKey = "thin_jd" | "initial_gate" | "all";

interface AnalyzeError {
  message:   string;
  /** API-side action hint. 'paste_jd' lets us offer a "Run anyway" button. */
  action?:   string;
  cta?:      { label: string; href: string };
}

/**
 * Click → POST /api/jobs/[id]/analyze. On success, navigate to the live
 * analysis page. On 422 (missing CV / AI key / thin JD), show an inline
 * toast — portal-rendered with `position: fixed` so it escapes the table's
 * `overflow:hidden`. For the thin-JD case (`action: 'paste_jd'`), the
 * toast also offers a "Run analysis anyway" button that retries with
 * ?override=thin_jd.
 */
export function AnalyzeJobButton({ jobId, hasAnalysis = false, analysisHref, override, compact }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr]              = useState<AnalyzeError | null>(null);
  const [toastPos, setToastPos]    = useState<{ top: number; right: number } | null>(null);
  const btnRef                     = useRef<HTMLButtonElement>(null);

  // External pending state — set when a sibling component (typically the
  // JobEditModal's "Save + auto-analyse" flow) starts an analysis for this
  // job. Clears itself when the parent re-renders with hasAnalysis=true
  // (the button is replaced by FullAnalysisButton at that point) or when
  // a matching "failed" event fires.
  const [externalPending, setExternalPending] = useState(false);
  useEffect(() => {
    function onStart(e: Event) {
      const ev = e as CustomEvent<{ jobId: string }>;
      if (ev.detail?.jobId === jobId) setExternalPending(true);
    }
    function onFail(e: Event) {
      const ev = e as CustomEvent<{ jobId: string }>;
      if (ev.detail?.jobId === jobId) setExternalPending(false);
    }
    window.addEventListener("jobtrackr:analysis-started", onStart);
    window.addEventListener("jobtrackr:analysis-failed",  onFail);
    return () => {
      window.removeEventListener("jobtrackr:analysis-started", onStart);
      window.removeEventListener("jobtrackr:analysis-failed",  onFail);
    };
  }, [jobId]);

  // Close the toast on outside click + Escape.
  useEffect(() => {
    if (!err) return;
    function handleEsc(e: KeyboardEvent) { if (e.key === "Escape") setErr(null); }
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [err]);

  async function runAnalyze(runtimeOverride?: OverrideKey) {
    setErr(null);

    const effective = runtimeOverride ?? override;
    const url = effective ? `/api/jobs/${jobId}/analyze?override=${effective}` : `/api/jobs/${jobId}/analyze`;

    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = (json.error as string) ?? `Failed (${res.status})`;
      const action  = (json.action as string | undefined) ?? undefined;
      // Pin the toast to the button's current position so portal-rendering
      // lands it next to the click target.
      if (btnRef.current) {
        const rect = btnRef.current.getBoundingClientRect();
        setToastPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
      }
      if (res.status === 402) {
        // Billing cap hit — point the user at the billing page with the reason.
        const reason = (json.reason as string | undefined) ?? "cv_unique_cap";
        setErr({ message, action, cta: { label: "Upgrade", href: `/billing?denied=${reason}` } });
      } else if (/active CV/i.test(message)) {
        setErr({ message, action, cta: { label: "Upload CV", href: "/cv" } });
      } else if (/AI key/i.test(message)) {
        setErr({ message, action, cta: { label: "Add AI key", href: "/integrations" } });
      } else {
        setErr({ message, action });
      }
      return;
    }
    router.push(`/jobs/${jobId}/analyze/${json.run_id}`);
  }

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    startTransition(() => runAnalyze());
  }

  function handleRunAnyway() {
    setErr(null);
    startTransition(() => runAnalyze("thin_jd"));
  }

  // ── Toast portal ──────────────────────────────────────────────────────────
  // `position: fixed` + max-width so it can't be clipped by an ancestor's
  // `overflow:hidden`. The button's screen position anchors the top/right.
  const toast = err && toastPos ? (
    <div
      style={{ position: "fixed", top: toastPos.top, right: toastPos.right, zIndex: 9999, maxWidth: 360 }}
      className="rounded-md bg-white border-2 border-red-200 shadow-lg px-3 py-3 anim-in"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-body leading-snug text-red-700 font-medium">{err.message}</p>

          {/* Action row — varies by error type */}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {err.action === "paste_jd" && (
              <button
                onClick={handleRunAnyway}
                disabled={pending}
                className="inline-flex items-center gap-1 text-caption font-semibold px-2 py-1 rounded border border-amber-400 bg-amber-50 text-amber-800 hover:bg-amber-100 transition-colors disabled:opacity-40"
                title="Run the full pipeline despite the thin job description"
              >
                {pending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                Run analysis anyway
              </button>
            )}
            {err.cta && (
              <Button
                variant="primary"
                size="sm"
                className="px-2 py-1"
                onClick={() => router.push(err.cta!.href)}
              >
                {err.cta.label}
              </Button>
            )}
            <button onClick={() => setErr(null)} className="inline-flex items-center gap-1 text-caption text-text-3 hover:text-text px-1 py-1">
              <X className="w-3 h-3" />
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      {compact ? (
        /* Compact override link — used inline next to a Below-initial badge. */
        <button ref={btnRef} disabled={pending} onClick={handleClick} className="inline-flex items-center gap-1 text-micro font-medium text-amber-700 hover:text-amber-900 hover:underline disabled:opacity-40 transition-colors" title={ override === "initial_gate" ? "Force the pipeline to tailor the CV anyway, despite low initial ATS score" : override === "thin_jd" ? "Run analysis anyway, despite a thin job description" : "Force analysis (override gate)" }>
          {pending ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Zap className="h-2.5 w-2.5" />}
          {pending ? "…" : "Force"}
        </button>
      ) : analysisHref && hasAnalysis ? (
        <Button asChild variant="brand" size="xs">
          <a href={analysisHref} title="View the full tailored analysis">
            <Sparkles className="h-3.5 w-3.5" />
            Full Analysis
          </a>
        </Button>
      ) : (
        /* Primary Analyze / Re-analyze button — brand-filled with Sparkles.
           Spins when an analysis is in-flight (either started locally or
           triggered by the JobEditModal's auto-analyse on save). No isLoading
           prop — the spin/label logic below already covers the pending
           state, and Button's own isLoading spinner would render a second,
           redundant one on top of it. */
        <Button
          ref={btnRef}
          variant="brand"
          size="xs"
          disabled={pending || externalPending}
          onClick={handleClick}
          title={
            externalPending
              ? "Analysis running — this button will become \"Full Analysis\" when it finishes"
              : hasAnalysis
              ? "Run a fresh analysis to update the tailored CV and scores"
              : "Run a CV-tailoring analysis against this job"
          }
        >
          {(pending || externalPending)
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <Sparkles className="h-3.5 w-3.5" />}
          <span>
            {externalPending
              ? "Analysing…"
              : pending
              ? "…"
              : hasAnalysis ? "Re-analyze" : "Analyze"}
          </span>
        </Button>
      )}
      {typeof document !== "undefined" && toast && createPortal(toast, document.body)}
    </>
  );
}

/**
 * When analysis exists, shows a plain "Full Analysis" link that navigates
 * to the full analysis results page. Re-analyze is in the card's ⋯ menu.
 */
export function FullAnalysisButton({
  analysisHref,
}: {
  jobId: string;
  analysisHref: string;
}) {
  return (
    <Button asChild variant="brand" size="xs">
      <a
        href={analysisHref}
        title="View the full tailored CV analysis"
        onClick={(e) => e.stopPropagation()}
      >
        <Sparkles className="h-3.5 w-3.5" />
        <span>Full Analysis</span>
      </a>
    </Button>
  );
}

/**
 * Trigger a re-analysis for a job (used by CardMenu's Re-analyze item).
 * Returns the new run_id on success, throws on failure.
 */
export async function triggerReanalyze(jobId: string): Promise<string> {
  const res  = await fetch(`/api/jobs/${jobId}/analyze`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json.error as string) ?? `Failed (${res.status})`);
  return json.run_id as string;
}
