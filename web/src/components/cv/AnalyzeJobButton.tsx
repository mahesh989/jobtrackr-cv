"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Loader2 } from "lucide-react";

interface Props {
  jobId: string;
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
export function AnalyzeJobButton({ jobId }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr]              = useState<AnalyzeError | null>(null);

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    setErr(null);
    startTransition(async () => {
      const res = await fetch(`/api/jobs/${jobId}/analyze`, { method: "POST" });
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
      {/* Analyze button — cv-magic pattern: brand-filled with Sparkles
          icon, swap to Loader2 while pending. Matches cv-magic's
          companies-client analyse button exactly. */}
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
