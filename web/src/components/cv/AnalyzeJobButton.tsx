"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Loader2, Zap } from "lucide-react";

interface Props {
  jobId: string;
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

interface AnalyzeError {
  message:   string;
  cta?:      { label: string; href: string };
}

/**
 * Click → POST /api/jobs/[id]/analyze. On success, navigate to the live
 * analysis page. On 422 (missing CV or AI key), show an inline error
 * with a link to the relevant settings page.
 */
export function AnalyzeJobButton({ jobId, override, compact }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr]              = useState<AnalyzeError | null>(null);

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    setErr(null);
    startTransition(async () => {
      // Read preferred provider from localStorage (set on Integrations page).
      let preferredProvider: string | null = null;
      try { preferredProvider = localStorage.getItem("jobtrackr-preferred-provider"); } catch {}

      const url = override ? `/api/jobs/${jobId}/analyze?override=${override}` : `/api/jobs/${jobId}/analyze`;
      const res = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(preferredProvider ? { provider: preferredProvider } : {}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = (json.error as string) ?? `Failed (${res.status})`;
        // Map common 422 prereq errors to a helpful CTA.
        if (/active CV/i.test(message)) {
          setErr({ message, cta: { label: "Upload CV", href: "/dashboard/cv" } });
        } else if (/AI key/i.test(message)) {
          setErr({ message, cta: { label: "Add AI key", href: "/dashboard/integrations" } });
        } else if (/job description text|expired|listing/i.test(message)) {
          setErr({
            message: "Not enough JD text to analyse. Use the ✏ Edit button on this row to paste the full job description manually.",
          });
        } else {
          setErr({ message });
        }
        return;
      }
      router.push(`/dashboard/jobs/${jobId}/analyze/${json.run_id}`);
    });
  }

  return (
    <>
      {compact ? (
        /* Compact override link — used inline next to a "Below initial"
           or "Needs JD" state badge. Smaller, ghost-styled. */
        <button
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
      ) : (
        /* Analyze button — cv-magic pattern: brand-filled with Sparkles
            icon, swap to Loader2 while pending. */
        <button
          disabled={pending}
          onClick={handleClick}
          className="flex items-center gap-1.5 rounded-md bg-[var(--brand)] px-2.5 py-1 text-xs font-medium text-[var(--brand-fg)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 transition-opacity"
          title="Run a CV-tailoring analysis against this job"
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          <span>{pending ? "…" : "Analyze"}</span>
        </button>
      )}

      {err && (
        <div
          className="absolute z-50 top-full right-0 mt-1 max-w-xs rounded-md bg-white border border-[#CF222E]/40 shadow-lg px-3 py-2.5 text-[12px] text-[#CF222E]"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="leading-snug">{err.message}</p>
          {err.cta && (
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => router.push(err.cta!.href)}
                className="gh-btn gh-btn-primary text-[11px] px-2 py-0.5"
              >
                {err.cta.label}
              </button>
              <button
                onClick={() => setErr(null)}
                className="gh-btn text-[11px] px-2 py-0.5"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
