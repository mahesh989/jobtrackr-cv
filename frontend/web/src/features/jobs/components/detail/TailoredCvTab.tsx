"use client";

/**
 * Tailored CV tab — preview directly (no separate download button in the
 * tab body per user feedback), plus a "View PDF" action that opens the
 * rendered PDF in a new tab. Downloading lives in the More tab.
 */

import { Loader2 } from "lucide-react";
import { CvInlinePreview } from "@/features/applications/components/CvInlinePreview";
import { useTailoredCvPdfAction } from "./useTailoredCvPdfAction";
import type { BoardDetailRun } from "../../lib/boardDetailTypes";

export function TailoredCvTab({ run }: { run: BoardDetailRun }) {
  const { pending, error, viewPdf } = useTailoredCvPdfAction(run.tailored_cv_storage_path);
  const feasibility = run.keyword_feasibility?.feasibility_plan;
  const extensionItems  = feasibility?.inject_as_extension ?? [];
  const inferenceItems  = feasibility?.inject_with_inference ?? [];
  const lift = run.tailored_match_score != null && run.match_score != null
    ? run.tailored_match_score - run.match_score
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        {lift != null && (
          <span className={`inline-flex items-center text-[13px] font-bold px-[11px] py-[4px] rounded-[20px] border ${lift >= 0 ? "bg-green-light text-green-700 border-green-500/30" : "bg-amber-light text-amber-700 border-amber-500/30"}`}>
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

      {error && <p className="text-label text-red-600">{error}</p>}

      {(extensionItems.length > 0 || inferenceItems.length > 0) && (
        <div className="space-y-2">
          <p className="text-[14px] text-text-2">Here&apos;s how tailoring adjusted the CV, honestly:</p>
          {extensionItems.map((it, i) => (
            <FeasibilityCard key={`ext-${i}`} keyword={it.keyword} tag="reworded" tagTone="blue" evidence={it.evidence} />
          ))}
          {inferenceItems.map((it, i) => (
            <FeasibilityCard key={`inf-${i}`} keyword={it.keyword} tag={`inferred · ${it.confidence ?? ""} confidence`} tagTone="purple" evidence={it.inferred_from?.join(", ")} evidenceLabel="Inferred from" />
          ))}
        </div>
      )}

      <CvInlinePreview storagePath={run.tailored_cv_storage_path} />
    </div>
  );
}

function FeasibilityCard({
  keyword, tag, tagTone, evidence, evidenceLabel = "From your CV",
}: {
  keyword?: string; tag: string; tagTone: "blue" | "purple"; evidence?: string; evidenceLabel?: string;
}) {
  return (
    <div className="rounded-[10px] border border-border bg-[#fafbfc] px-3.5 py-3">
      <div className="flex items-center gap-2">
        <span className="text-[14px] font-bold text-text">{keyword}</span>
        <span className={`inline-flex items-center text-[10.5px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-[5px] ${tagTone === "blue" ? "bg-[#eef3ff] text-[#2563eb]" : "bg-[#f5f3ff] text-[#7c3aed]"}`}>{tag}</span>
      </div>
      {evidence && (
        <p className="text-[13px] text-text-2 mt-1.5 italic">
          {evidenceLabel}: <span className="not-italic font-semibold text-text">&quot;{evidence}&quot;</span>
        </p>
      )}
    </div>
  );
}
