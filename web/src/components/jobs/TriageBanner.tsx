"use client";

/**
 * Dashboard triage banner.
 *
 * One concise row at the top of the jobs board listing actionable
 * counts that need user attention. Click a count → adds the
 * corresponding chip to the URL → filter applies.
 *
 * Hidden when all counts are zero. Dismissable per browser-session
 * (sessionStorage, not localStorage — re-appears on next browser session
 * so users don't permanently silence triage signals).
 */

import { useState, useEffect } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { AlertTriangle, X } from "lucide-react";

export interface TriageCounts {
  needsJd:      number;
  roleMismatch: number;
  autoSkipped:  number;
}

const DISMISS_KEY = "jobtrackr-triage-banner-dismissed";

export function TriageBanner({ counts }: { counts: TriageCounts }) {
  const router   = useRouter();
  const pathname = usePathname();
  const sp       = useSearchParams();
  const [, startTransition] = useTransition();
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    setDismissed(typeof window !== "undefined" && window.sessionStorage.getItem(DISMISS_KEY) === "1");
  }, []);

  const total = counts.needsJd + counts.roleMismatch + counts.autoSkipped;
  if (dismissed === null) return null; // SSR / loading
  if (dismissed)          return null;
  if (total === 0)        return null;

  function dismiss() {
    try { window.sessionStorage.setItem(DISMISS_KEY, "1"); } catch { /* quota */ }
    setDismissed(true);
  }

  function applyChip(chip: string) {
    const params = new URLSearchParams(sp.toString());
    params.set("chips", chip);
    startTransition(() => router.replace(`${pathname}?${params}`));
  }

  const messages: Array<{ chip: string; text: string; count: number }> = [];
  if (counts.needsJd > 0) {
    messages.push({
      chip:  "needsJd",
      text:  `${counts.needsJd} job${counts.needsJd === 1 ? "" : "s"} need a JD pasted to be analysed`,
      count: counts.needsJd,
    });
  }
  if (counts.roleMismatch > 0) {
    messages.push({
      chip:  "roleMismatch",
      text:  `${counts.roleMismatch} job${counts.roleMismatch === 1 ? "" : "s"} flagged as role mismatch`,
      count: counts.roleMismatch,
    });
  }
  if (counts.autoSkipped > 0) {
    messages.push({
      chip:  "autoSkipped",
      text:  `${counts.autoSkipped} job${counts.autoSkipped === 1 ? "" : "s"} auto-skipped by ATS threshold`,
      count: counts.autoSkipped,
    });
  }

  return (
    <div className="flex items-start gap-3 px-4 py-2.5 rounded-md border border-amber-200 bg-amber-50 anim-in">
      <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        {messages.map((m) => (
          <div key={m.chip} className="flex items-center gap-2 flex-wrap">
            <span className="text-[12px] text-amber-900">{m.text}</span>
            <button
              onClick={() => applyChip(m.chip)}
              className="text-[11px] font-medium text-amber-800 underline-offset-2 hover:underline"
            >
              Show →
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={dismiss}
        title="Hide for this session"
        className="inline-flex items-center justify-center w-6 h-6 rounded text-amber-700 hover:text-amber-900 hover:bg-amber-100 transition-colors shrink-0"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
