"use client";

/**
 * Cover letter tab — preview directly, "View PDF" opens the existing
 * job+letter-scoped PDF route (already `Content-Disposition: inline`) in a
 * new tab. No download button here — that's in the More tab.
 */

import type { BoardDetailCoverLetter } from "../../lib/boardDetailTypes";

export function CoverLetterTab({ jobId, letter }: { jobId: string; letter: BoardDetailCoverLetter }) {
  const text = (letter.pass_3_final ?? "").trim();
  const wordCount = text ? text.split(/\s+/).length : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[13px] text-text-2">
          {wordCount > 0 ? `${wordCount}-word draft` : "Draft"}{letter.tone_target ? ` · ${letter.tone_target} tone` : ""}
        </span>
        <a
          href={`/api/jobs/${jobId}/cover-letter/${letter.id}/download?format=pdf`}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto text-[13px] font-medium text-[var(--brand)] hover:underline"
        >
          View PDF ↗
        </a>
      </div>

      {text ? (
        <div className="rounded-[10px] border border-border bg-[#fafbfc] px-[22px] py-5 max-h-[400px] overflow-y-auto">
          <p className="text-[14px] text-text whitespace-pre-wrap leading-relaxed">{text}</p>
        </div>
      ) : (
        <p className="text-label text-text-3 italic">No cover letter text yet.</p>
      )}
    </div>
  );
}
