"use client";

/**
 * Tailored CV tab — preview directly (no separate download button in the
 * tab body per user feedback), plus a "View PDF" action that opens the
 * rendered PDF in a new tab. Downloading lives in the More tab. The
 * per-keyword tailoring rationale ("how tailoring adjusted the CV") is
 * deliberately not shown here — it lives on the full analysis page.
 */

import { Loader2 } from "lucide-react";
import { CvInlinePreview } from "@/features/applications/components/CvInlinePreview";
import { useTailoredCvPdfAction } from "./useTailoredCvPdfAction";
import type { BoardDetailRun } from "../../lib/boardDetailTypes";

export function TailoredCvTab({ run }: { run: BoardDetailRun }) {
  const { pending, error, viewPdf } = useTailoredCvPdfAction(run.tailored_cv_storage_path);
  const lift = run.tailored_match_score != null && run.match_score != null
    ? run.tailored_match_score - run.match_score
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        {lift != null && (
          <span className={`inline-flex items-center text-[13px] font-bold px-[11px] py-[4px] rounded-[20px] border ${lift >= 0 ? "bg-success-subtle text-success border-success-border" : "bg-warning-subtle text-warning border-warning-border"}`}>
            {lift >= 0 ? "+" : ""}{lift} lift · {run.match_score} → {run.tailored_match_score}
          </span>
        )}
        <div className="ml-auto">
          <button
            type="button"
            onClick={viewPdf}
            disabled={pending !== null}
            className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--brand)] hover:underline disabled:opacity-50"
          >
            {pending === "view" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            View PDF ↗
          </button>
        </div>
      </div>

      {error && <p className="text-label text-danger">{error}</p>}

      <CvInlinePreview storagePath={run.tailored_cv_storage_path} />
    </div>
  );
}
