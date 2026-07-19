"use client";

import { useState } from "react";
import { FileWarning, X } from "lucide-react";
import { Button } from "@/components/ui";

/**
 * Dismissible inline banner shown whenever the current job board view
 * contains jobs with thin (incomplete) job descriptions.
 * Dismissed state is session-only — the banner reappears on next page load
 * if thin-JD jobs still exist, so users can't accidentally miss them.
 */
export function ThinJdBanner({ count }: { count: number }) {
  const [dismissed, setDismissed] = useState(false);

  if (count === 0 || dismissed) return null;

  return (
    <div className="rounded-lg border border-[var(--amber)]/40 bg-[var(--amber)]/8 px-4 py-3 flex gap-3 items-start">
      <FileWarning className="w-4 h-4 shrink-0 mt-0.5 text-[var(--amber)]" />
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-semibold text-text mb-1">
          {count} job{count !== 1 ? "s have" : " has"} an incomplete job description
        </p>
        <p className="text-[12px] text-text-2 mb-2">
          Jobs without a full description can&apos;t be analysed. Here&apos;s how to fix them:
        </p>
        <ol className="text-[12px] text-text-2 space-y-1 list-decimal list-inside">
          <li>Click <span className="font-medium text-text">···</span> on the job card → <span className="font-medium text-text">Edit JD</span></li>
          <li>Open the job posting link shown in the editor</li>
          <li>Copy and paste the full job description into the text box</li>
          <li>Optionally add the recruiter email to apply directly by email</li>
          <li>Hit <span className="font-medium text-text">Save</span> — analysis starts automatically</li>
        </ol>
      </div>
      <Button
        type="button"
        onClick={() => setDismissed(true)}
        className="shrink-0 p-0.5 rounded hover:bg-[var(--surface-2)] transition-colors text-text-3 hover:text-text"
        aria-label="Dismiss"
      >
        <X className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}
