"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, HelpCircle } from "lucide-react";

/**
 * Collapsible "How does Application Pool work?" panel.
 * Shown only on the pool tab. Collapsed state persists in localStorage so
 * users who've read it don't see it expanded every visit.
 */
export function PoolHowItWorks() {
  const [open, setOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("pool-howto-collapsed") !== "1";
  });

  function toggle() {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem("pool-howto-collapsed", next ? "0" : "1"); } catch { /* ignore */ }
  }

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <button type="button" onClick={toggle} className="w-full flex items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-[var(--surface-2)] transition-colors">
        <span className="flex items-center gap-2 text-[12px] font-medium text-text-2">
          <HelpCircle className="w-3.5 h-3.5 shrink-0 text-[var(--brand)]" />
          How does Application Pool work?
        </span>
        {open
          ? <ChevronUp className="w-3.5 h-3.5 shrink-0 text-text-3" />
          : <ChevronDown className="w-3.5 h-3.5 shrink-0 text-text-3" />
        }
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-border space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            {/* Option A */}
            <div className="rounded-md border border-border bg-[var(--surface-2)] p-3 space-y-1.5">
              <p className="text-[12px] font-semibold text-text">Option A — You have a recruiter email</p>
              <ol className="text-[12px] text-text-2 space-y-1 list-decimal list-inside">
                <li>Add the email via the card (find it on the job posting link)</li>
                <li>Hit <span className="font-medium text-text">Apply Now</span> → your tailored CV, cover letter, and email message are sent automatically</li>
                <li>The job moves to the <span className="font-medium text-text">Sent/Applied</span> tab</li>
              </ol>
            </div>

            {/* Option B */}
            <div className="rounded-md border border-border bg-[var(--surface-2)] p-3 space-y-1.5">
              <p className="text-[12px] font-semibold text-text">Option B — No email (apply on the job site)</p>
              <ol className="text-[12px] text-text-2 space-y-1 list-decimal list-inside">
                <li>Preview the PDF versions of your CV and cover letter, then download them</li>
                <li>Hit <span className="font-medium text-text">Apply Now</span> → redirected to the job site (e.g. SEEK)</li>
                <li>Sign in / create an account, then upload your CV and cover letter</li>
                <li>The job moves to the <span className="font-medium text-text">Sent/Applied</span> tab</li>
              </ol>
            </div>
          </div>

          <p className="text-[11px] text-text-3 border-t border-border pt-2.5">
            <span className="font-medium text-text-2">Accidentally hit Apply Now?</span>{" "}
            You can move any job back to Application Pool from the Sent/Applied tab.
          </p>
        </div>
      )}
    </div>
  );
}
