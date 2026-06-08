"use client";

import { useState, useTransition, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Sparkles, Loader2, Zap, AlertTriangle, X, FileText } from "lucide-react";

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

  // Close the toast on outside click + Escape.
  useEffect(() => {
    if (!err) return;
    function handleEsc(e: KeyboardEvent) { if (e.key === "Escape") setErr(null); }
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [err]);

  async function runAnalyze(runtimeOverride?: OverrideKey) {
    setErr(null);
    let preferredProvider: string | null = null;
    try { preferredProvider = localStorage.getItem("jobtrackr-preferred-provider"); } catch {}

    const effective = runtimeOverride ?? override;
    const url = effective ? `/api/jobs/${jobId}/analyze?override=${effective}` : `/api/jobs/${jobId}/analyze`;

    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(preferredProvider ? { provider: preferredProvider } : {}),
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
        setErr({ message, action, cta: { label: "Upgrade", href: `/dashboard/billing?denied=${reason}` } });
      } else if (/active CV/i.test(message)) {
        setErr({ message, action, cta: { label: "Upload CV", href: "/dashboard/cv" } });
      } else if (/AI key/i.test(message)) {
        setErr({ message, action, cta: { label: "Add AI key", href: "/dashboard/integrations" } });
      } else {
        setErr({ message, action });
      }
      return;
    }
    router.push(`/dashboard/jobs/${jobId}/analyze/${json.run_id}`);
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
          <p className="text-[13px] leading-snug text-red-700 font-medium">{err.message}</p>

          {/* Action row — varies by error type */}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {err.action === "paste_jd" && (
              <button
                onClick={handleRunAnyway}
                disabled={pending}
                className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded border border-amber-400 bg-amber-50 text-amber-800 hover:bg-amber-100 transition-colors disabled:opacity-40"
                title="Run the full pipeline despite the thin job description"
              >
                {pending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                Run analysis anyway
              </button>
            )}
            {err.cta && (
              <button
                onClick={() => router.push(err.cta!.href)}
                className="gh-btn gh-btn-primary text-[11px] px-2 py-1"
              >
                {err.cta.label}
              </button>
            )}
            <button
              onClick={() => setErr(null)}
              className="inline-flex items-center gap-1 text-[11px] text-text-3 hover:text-text px-1 py-1"
            >
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
        <button
          ref={btnRef}
          disabled={pending}
          onClick={handleClick}
          className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-700 hover:text-amber-900 hover:underline disabled:opacity-40 transition-colors"
          title={
            override === "initial_gate"
              ? "Force the pipeline to tailor the CV anyway, despite low initial ATS score"
              : override === "thin_jd"
              ? "Run analysis anyway, despite a thin job description"
              : "Force analysis (override gate)"
          }
        >
          {pending ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Zap className="h-2.5 w-2.5" />}
          {pending ? "…" : "Force"}
        </button>
      ) : analysisHref && hasAnalysis ? (
        <a
          href={analysisHref}
          className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700 transition-colors"
          title="View the full tailored analysis"
        >
          <FileText className="h-3.5 w-3.5" />
          Full Analysis
        </a>
      ) : (
        /* Primary Analyze / Re-analyze button — brand-filled with Sparkles. */
        <button
          ref={btnRef}
          disabled={pending}
          onClick={handleClick}
          className="flex items-center gap-1.5 rounded-md bg-[var(--brand)] px-2.5 py-1 text-xs font-medium text-[var(--brand-fg)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 transition-opacity"
          title={hasAnalysis ? "Run a fresh analysis to update the tailored CV and scores" : "Run a CV-tailoring analysis against this job"}
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          <span>{pending ? "…" : hasAnalysis ? "Re-analyze" : "Analyze"}</span>
        </button>
      )}
      {typeof document !== "undefined" && toast && createPortal(toast, document.body)}
    </>
  );
}

/**
 * When analysis exists, shows a "Full Analysis" link (navigates to the result)
 * plus a "Re-analyze" option via a small dropdown.
 */
export function FullAnalysisButton({
  jobId,
  analysisHref,
}: {
  jobId: string;
  analysisHref: string;
}) {
  const [open, setOpen]            = useState(false);
  const [pending, startTransition] = useTransition();
  const [err, setErr]              = useState<string | null>(null);
  const router                     = useRouter();
  const menuRef                    = useRef<HTMLDivElement>(null);
  const btnRef                     = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos]      = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
          btnRef.current  && !btnRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onEsc(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown",   onEsc);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown",   onEsc);
    };
  }, [open]);

  function toggleMenu(e: React.MouseEvent) {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setOpen((v) => !v);
  }

  async function handleReanalyze(e: React.MouseEvent) {
    e.stopPropagation();
    setOpen(false);
    setErr(null);
    let preferredProvider: string | null = null;
    try { preferredProvider = localStorage.getItem("jobtrackr-preferred-provider"); } catch {}
    startTransition(async () => {
      const res  = await fetch(`/api/jobs/${jobId}/analyze`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(preferredProvider ? { provider: preferredProvider } : {}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setErr((json.error as string) ?? "Failed"); return; }
      router.push(`/dashboard/jobs/${jobId}/analyze/${json.run_id}`);
    });
  }

  return (
    <div className="relative flex items-center" onClick={(e) => e.stopPropagation()}>
      {/* Full Analysis link */}
      <a
        href={analysisHref}
        className="flex items-center gap-1.5 rounded-l-md bg-[var(--brand)] px-2.5 py-1 text-xs font-medium text-[var(--brand-fg)] hover:opacity-90 transition-opacity"
        title="View the full tailored CV analysis"
        onClick={(e) => e.stopPropagation()}
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
        <span>Full Analysis</span>
      </a>
      {/* Dropdown chevron */}
      <button
        ref={btnRef}
        onClick={toggleMenu}
        disabled={pending}
        className="flex items-center justify-center rounded-r-md bg-[var(--brand)] border-l border-[var(--brand-fg)]/20 px-1.5 py-1 text-[var(--brand-fg)] hover:opacity-90 disabled:opacity-40 transition-opacity"
        title="More options"
        aria-label="More analysis options"
      >
        <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>

      {/* Dropdown menu */}
      {open && menuPos && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          style={{ position: "fixed", top: menuPos.top, right: menuPos.right, zIndex: 9999 }}
          className="min-w-[140px] rounded-md border border-border bg-surface shadow-lg py-1 text-[12px]"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={handleReanalyze}
            disabled={pending}
            className="w-full text-left flex items-center gap-2 px-3 py-1.5 hover:bg-surface-2 text-text transition-colors disabled:opacity-40"
          >
            <Sparkles className="w-3.5 h-3.5 text-text-2" />
            Re-analyze
          </button>
        </div>,
        document.body,
      )}

      {err && (
        <span className="absolute top-full right-0 mt-1 text-[10px] text-red-600 whitespace-nowrap bg-white border border-red-200 rounded px-2 py-0.5 shadow z-50">
          {err}
        </span>
      )}
    </div>
  );
}
